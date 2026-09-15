use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    io::{self, IsTerminal, Write, stdout},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers, MouseButton, MouseEventKind,
    },
    execute, queue,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor},
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use serde::Deserialize;
use signal_hook::{
    consts::{SIGINT, SIGTERM},
    flag,
};

#[derive(Default, Deserialize)]
struct Snapshot {
    machines: Vec<Machine>,
    spending: String,
    message: String,
    available: Option<Catalog>,
    #[serde(default)]
    gateways: Vec<Gateway>,
    #[serde(default)]
    storage: Option<Storage>,
}

#[derive(Deserialize)]
struct Gateway {
    id: String,
    gateway: String,
    operator: String,
    price: Option<String>,
    payment: Option<String>,
    limitations: Option<String>,
    evidence: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Storage {
    directory: String,
    available_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    machines: Vec<Offer>,
    ceiling: String,
    fetched_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Offer {
    id: String,
    provider: String,
    #[serde(default)]
    operator: String,
    provider_warning: bool,
    cpu: f64,
    memory: f64,
    disk: u64,
    daily: String,
    regions: Vec<String>,
    within_cap: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Machine {
    name: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    unresolved: bool,
    phase: String,
    provider: String,
    #[serde(default)]
    provider_warning: bool,
    finished: bool,
    ssh: bool,
    requested: String,
    expiry: Option<u64>,
    estimated: bool,
    paid: String,
    paid_units: Option<String>,
    capacity: String,
    started: String,
    ended: String,
    cap: String,
    quote: String,
    exported: String,
    check_cap: String,
    #[serde(default)]
    managed: bool,
    #[serde(default)]
    experiment: Option<Experiment>,
    #[serde(default)]
    task_detail: String,
    transactions: Vec<Transaction>,
}

#[derive(Deserialize)]
struct Experiment {
    name: String,
    role: String,
}

#[derive(Deserialize)]
struct Transaction {
    paid: String,
    operation: String,
    hash: String,
}

struct View {
    filter: usize,
    sort: usize,
    index: usize,
    detail: bool,
    offset: usize,
    top: usize,
    help: bool,
    storage: bool,
    g_pending: bool,
    quit_pending: bool,
    confirm: Option<String>,
    message: String,
    message_sticky: bool,
    available: bool,
    prices: PriceView,
    region: usize,
    collapsed: BTreeSet<GroupKey>,
}

impl Default for View {
    fn default() -> Self {
        Self {
            filter: 0,
            sort: 0,
            index: 0,
            detail: false,
            offset: 0,
            top: 0,
            help: false,
            storage: false,
            g_pending: false,
            quit_pending: false,
            confirm: None,
            message: String::new(),
            message_sticky: false,
            available: false,
            prices: PriceView::WithinBudget,
            region: 0,
            collapsed: BTreeSet::from([GroupKey::Retained]),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum PriceView {
    WithinBudget,
    AllPrices,
    Gateways,
}

impl PriceView {
    fn next(self) -> Self {
        match self {
            Self::WithinBudget => Self::AllPrices,
            Self::AllPrices => Self::Gateways,
            Self::Gateways => Self::WithinBudget,
        }
    }
}

fn offers<'a>(data: &'a Snapshot, view: &View) -> Vec<&'a Offer> {
    data.available.as_ref().map_or_else(Vec::new, |catalog| {
        catalog
            .machines
            .iter()
            .filter(|m| {
                view.prices != PriceView::Gateways
                    && (view.prices == PriceView::AllPrices || m.within_cap)
            })
            .collect()
    })
}

fn available_count(data: &Snapshot, view: &View) -> usize {
    if view.prices == PriceView::Gateways {
        data.gateways.len()
    } else {
        offers(data, view).len()
    }
}

const FILTERS: [&str; 3] = ["tasks", "active", "all records"];
const SORTS: [&str; 4] = ["recent", "name", "paid", "expiry"];

fn machines<'a>(data: &'a Snapshot, view: &View) -> Vec<&'a Machine> {
    let mut rows: Vec<_> = data
        .machines
        .iter()
        .filter(|m| match view.filter {
            1 => m.active,
            2 => true,
            _ => m.managed || !m.finished,
        })
        .collect();
    rows.sort_by(|a, b| {
        match view.sort {
            1 => a.name.cmp(&b.name),
            2 => b
                .paid_units
                .as_ref()
                .and_then(|v| v.parse::<u128>().ok())
                .cmp(&a.paid_units.as_ref().and_then(|v| v.parse::<u128>().ok())),
            3 => (if a.finished {
                u64::MAX
            } else {
                a.expiry.unwrap_or(u64::MAX)
            })
            .cmp(
                &(if b.finished {
                    u64::MAX
                } else {
                    b.expiry.unwrap_or(u64::MAX)
                }),
            ),
            _ => b.requested.cmp(&a.requested),
        }
        .then_with(|| a.name.cmp(&b.name))
    });
    rows
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum GroupKey {
    NeedsReview,
    Experiment(String),
    Managed,
    Retained,
}

impl GroupKey {
    fn title(&self) -> String {
        match self {
            Self::NeedsReview => "Needs review".into(),
            Self::Experiment(name) => format!("Experiment: {name}"),
            Self::Managed => "Managed tasks".into(),
            Self::Retained => "Retained workspaces".into(),
        }
    }
}

fn group_key(machine: &Machine) -> GroupKey {
    if let Some(experiment) = machine.experiment.as_ref().filter(|_| machine.managed) {
        GroupKey::Experiment(experiment.name.clone())
    } else if machine.managed {
        GroupKey::Managed
    } else if !machine.finished {
        GroupKey::NeedsReview
    } else {
        GroupKey::Retained
    }
}

enum Row<'a> {
    Group(GroupKey, usize),
    Machine(&'a Machine),
}

fn grouped<'a>(data: &'a Snapshot, view: &View) -> Vec<Row<'a>> {
    let mut groups: BTreeMap<GroupKey, Vec<&Machine>> = BTreeMap::new();
    for machine in machines(data, view) {
        groups.entry(group_key(machine)).or_default().push(machine);
    }
    let mut rows = Vec::new();
    for (group, machines) in groups {
        rows.push(Row::Group(group.clone(), machines.len()));
        if !view.collapsed.contains(&group) {
            rows.extend(machines.into_iter().map(Row::Machine));
        }
    }
    rows
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Selection {
    Group(GroupKey),
    Machine(String),
}

fn selection(data: &Snapshot, view: &View) -> Option<Selection> {
    grouped(data, view).get(view.index).map(|row| match row {
        Row::Group(group, _) => Selection::Group(group.clone()),
        Row::Machine(machine) => Selection::Machine(machine.name.clone()),
    })
}

fn restore_selection(data: &Snapshot, view: &mut View, previous: Option<Selection>) {
    let rows = grouped(data, view);
    let found = previous.as_ref().and_then(|selection| {
        rows.iter().position(|row| match (row, selection) {
            (Row::Group(group, _), Selection::Group(previous)) => group == previous,
            (Row::Machine(machine), Selection::Machine(previous)) => &machine.name == previous,
            _ => false,
        })
    });
    if matches!(previous, Some(Selection::Machine(_))) && found.is_none() {
        view.detail = false;
        view.offset = 0;
    }
    view.index = found.unwrap_or(view.index.min(rows.len().saturating_sub(1)));
}

fn selected<'a>(data: &'a Snapshot, view: &View) -> Option<&'a Machine> {
    match grouped(data, view).get(view.index) {
        Some(Row::Machine(machine)) => Some(*machine),
        _ => None,
    }
}

fn remaining(m: &Machine) -> String {
    if m.finished {
        return if m.phase == "not_submitted" {
            "not rented"
        } else {
            "closed"
        }
        .into();
    }
    let Some(expiry) = m.expiry else {
        return "unknown".into();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if expiry <= now {
        return "check expiry".into();
    }
    let secs = expiry - now;
    format!(
        "{}h {:02}m{}",
        secs / 3600,
        secs / 60 % 60,
        if m.estimated { " ~" } else { "" }
    )
}

fn snapshot_cue(previous: &Snapshot, next: &Snapshot) -> Option<String> {
    let previous: BTreeMap<_, _> = previous
        .machines
        .iter()
        .map(|machine| (machine.name.as_str(), machine))
        .collect();
    let mut ready = Vec::new();
    let mut finished = Vec::new();
    let mut not_rented = Vec::new();
    for machine in &next.machines {
        let Some(before) = previous.get(machine.name.as_str()) else {
            continue;
        };
        if !machine.finished && !before.ssh && machine.ssh {
            ready.push(machine.name.as_str());
        }
        if !before.finished && machine.finished {
            if ["not_submitted", "not_purchased"].contains(&machine.phase.as_str()) {
                not_rented.push(machine.name.as_str());
            } else {
                finished.push(format!("{} ({})", machine.name, machine.phase));
            }
        }
    }
    let mut parts = Vec::new();
    if !ready.is_empty() {
        parts.push(format!(
            "Ready: {}. Open SSH for a terminal.",
            ready.join(", ")
        ));
    }
    if !finished.is_empty() {
        parts.push(format!(
            "Finished: {}. Review cleanup details.",
            finished.join(", ")
        ));
    }
    if !not_rented.is_empty() {
        parts.push(format!("Not rented: {}.", not_rented.join(", ")));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn quit_key(pending: &mut bool, key: &KeyEvent) -> bool {
    if key.kind == KeyEventKind::Release {
        return false;
    }
    if key.code == KeyCode::Char('q') {
        if key.kind == KeyEventKind::Repeat {
            return false;
        }
        if *pending {
            *pending = false;
            return true;
        }
        *pending = true;
    } else {
        *pending = false;
    }
    false
}

// External strings are data, never terminal controls or bidi instructions.
fn clip(text: &str, width: usize) -> String {
    let safe: Vec<_> = text
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '?'
            }
        })
        .collect();
    if safe.len() <= width {
        return safe.into_iter().collect();
    }
    safe.into_iter()
        .take(width.saturating_sub(1))
        .chain(std::iter::once('~').take(usize::from(width > 0)))
        .collect()
}

struct Screen;
impl Screen {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let guard = Self;
        execute!(stdout(), EnterAlternateScreen, EnableMouseCapture, Hide)?;
        Ok(guard)
    }
}
impl Drop for Screen {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(
            stdout(),
            SetAttribute(Attribute::Reset),
            ResetColor,
            Show,
            DisableMouseCapture,
            LeaveAlternateScreen
        );
    }
}

// Rendering and mouse hit targets share the same labels and coordinates.
struct Hit {
    row: u16,
    start: u16,
    end: u16,
    key: KeyCode,
}

fn buttons(lines: &mut Vec<(String, u8)>, hits: &mut Vec<Hit>, items: &[(&str, KeyCode)]) {
    let mut text = String::new();
    for (label, key) in items {
        if !text.is_empty() {
            text.push_str("  ");
        }
        let start = text.len() as u16 + 2;
        text.push_str(label);
        hits.push(Hit {
            row: lines.len() as u16,
            start,
            end: text.len() as u16 + 2,
            key: *key,
        });
    }
    lines.push((text, 2));
}

fn money(value: &str) -> String {
    if let Some((whole, fraction)) = value.split_once('.') {
        let fraction = fraction.trim_end_matches('0');
        format!("{whole}.{fraction:0<2}")
    } else {
        value.into()
    }
}

fn render(
    data: &Snapshot,
    view: &mut View,
    busy: bool,
    loading: bool,
    previous: &mut Vec<u8>,
) -> io::Result<Vec<Hit>> {
    let (columns, height) = terminal::size()?;
    let width = usize::from(columns.saturating_sub(4));
    let height = usize::from(height);
    let mut lines: Vec<(String, u8)> = Vec::new();
    let mut hits = Vec::new();
    if columns < 56 || height < 16 {
        lines.push((
            if view.quit_pending {
                "Press q again to quit."
            } else {
                "fission"
            }
            .into(),
            1,
        ));
        lines.push(("Enlarge the terminal to at least 56 x 16.".into(), 0));
        lines.push(("qq quit".into(), 2));
    } else {
        lines.push((String::new(), 0));
        buttons(
            &mut lines,
            &mut hits,
            &[
                ("fission", KeyCode::Null),
                (
                    if view.available { " Tasks " } else { "[Tasks]" },
                    KeyCode::Char('1'),
                ),
                (
                    if view.available {
                        "[Available]"
                    } else {
                        " Available "
                    },
                    KeyCode::Char('2'),
                ),
                ("[Storage]", KeyCode::Char('o')),
                ("[?]", KeyCode::Char('?')),
            ],
        );
        lines.last_mut().unwrap().1 = 1;
        lines.push(("-".repeat(width), 2));
        let count = height.saturating_sub(12).max(1);
        let length = if view.available {
            available_count(data, view)
        } else {
            grouped(data, view).len()
        };
        view.index = view.index.min(length.saturating_sub(1));
        view.top = view.top.min(length.saturating_sub(count)).min(view.index);
        if view.index >= view.top + count {
            view.top = view.index + 1 - count;
        }
        if let Some(name) = &view.confirm {
            lines.push(("Stop and destroy this machine?".into(), 1));
            lines.push((name.clone(), 3));
            lines.push((
                "Only this machine; experiment peers keep running.".into(),
                0,
            ));
            lines.push(("Kept: task/experiment folders, evidence/reports,".into(), 1));
            lines.push(("and caches already saved by successful builds.".into(), 0));
            lines.push(("May lose guest files not yet collected.".into(), 1));
            lines.push(("Stopping does not guarantee a new cache save.".into(), 0));
            lines.push(("Cleanup still requires destruction confirmation.".into(), 2));
        } else if view.storage {
            lines.push(("Local storage".into(), 1));
            if let Some(storage) = &data.storage {
                lines.push((storage.directory.clone(), 0));
                lines.push((
                    storage.available_bytes.map_or_else(
                        || "Capacity unavailable".into(),
                        |bytes| format!("{} GiB available", bytes / 1_073_741_824),
                    ),
                    0,
                ));
            }
            lines.push((String::new(), 0));
            lines.push(("Local files stay after a rental closes.".into(), 0));
            lines.push((String::new(), 0));
            lines.push(("Choose a directory or mounted drive:".into(), 0));
            lines.push(("FISSION_STORAGE_DIR=/path/to/storage fission".into(), 0));
            lines.push(("Agent commands also accept --storage-dir PATH.".into(), 2));
        } else if view.help {
            for (text, style) in [
                ("Navigation", 1),
                ("j/k move   h/Esc back   l/Enter open", 0),
                ("gg/G first/last   Ctrl-u/Ctrl-d half page", 0),
                ("Tab or 1/2 switch tabs   qq quit", 0),
                ("Click task to inspect; click SSH for a terminal.", 2),
                ("f filter   s sort   r refresh", 0),
                ("Available: b budget/all prices/gateways", 0),
                ("VM offers: [ / ] region; Enter quotes without payment", 0),
                ("Task: u resume   x stop   p provider check", 0),
                ("tmux: SSH opens a popup; otherwise it is fullscreen.", 0),
                ("Fullscreen SSH pauses dashboard refresh until exit.", 0),
                ("New task: fission run (see fission help run)", 0),
                ("v verify payments   ? close help", 0),
            ] {
                lines.push((text.into(), style));
            }
        } else if view.available {
            if view.prices == PriceView::Gateways {
                if view.detail {
                    if let Some(gateway) = data.gateways.get(view.index) {
                        lines.push((gateway.id.clone(), 1));
                        lines.push((format!("{} -> {}", gateway.gateway, gateway.operator), 2));
                        lines.push((String::new(), 0));
                        let mut detail = Vec::new();
                        for text in [
                            &gateway.price,
                            &gateway.payment,
                            &gateway.limitations,
                            &gateway.evidence,
                        ]
                        .into_iter()
                        .flatten()
                        {
                            // Keep scope and billing units readable at narrow widths.
                            let mut line = String::new();
                            for word in text.split_whitespace() {
                                if !line.is_empty() && line.len() + word.len() + 1 > width {
                                    detail.push((line, 0));
                                    line = String::new();
                                }
                                if !line.is_empty() {
                                    line.push(' ');
                                }
                                line.push_str(word);
                            }
                            detail.push((line, 0));
                        }
                        view.offset = view.offset.min(detail.len().saturating_sub(1));
                        lines.extend(detail.into_iter().skip(view.offset));
                    }
                } else {
                    lines.push((
                        format!("Gateways   {} available routes", data.gateways.len()),
                        1,
                    ));
                    lines.push(("Gateway routes payments; operator runs compute.".into(), 2));
                    lines.push((String::new(), 0));
                    let nw = width.saturating_sub(19);
                    lines.push((format!("  {:<nw$} operator", "route"), 2));
                    for (i, gateway) in data.gateways.iter().enumerate().skip(view.top).take(count)
                    {
                        lines.push((
                            format!(
                                "{} {:<nw$} {}",
                                if i == view.index { ">" } else { " " },
                                clip(&gateway.gateway, nw),
                                clip(&gateway.operator, 16),
                            ),
                            if i == view.index { 3 } else { 0 },
                        ));
                    }
                }
            } else if let Some(catalog) = &data.available {
                let available = offers(data, view);
                if view.detail {
                    if let Some(m) = available.get(view.index) {
                        lines.push((m.id.clone(), 1));
                        lines.push((
                            format!("Gateway {} -> {}   Linux x86_64", m.provider, m.operator),
                            2,
                        ));
                        if m.provider_warning {
                            lines
                                .push(("Provider history warning: verify availability.".into(), 2));
                        }
                        lines.push((String::new(), 0));
                        lines.push((
                            format!(
                                "Hardware   {} vCPU   {} GiB RAM   {} GiB disk",
                                m.cpu, m.memory, m.disk
                            ),
                            0,
                        ));
                        lines.push((
                            format!("Estimate   {} USDC.e / 24 hours", money(&m.daily)),
                            0,
                        ));
                        lines.push((
                            format!(
                                "Region     {}   ({} of {})",
                                m.regions
                                    .get(view.region % m.regions.len().max(1))
                                    .map_or("unknown", String::as_str),
                                view.region + 1,
                                m.regions.len()
                            ),
                            0,
                        ));
                        lines.push((String::new(), 0));
                        lines.push(("Enter requests a fresh 24-hour quote.".into(), 2));
                    }
                } else {
                    lines.push((format!("VM offers   {} options", available.len()), 1));
                    lines.push((
                        format!(
                            "{}   VM budget: {} USDC.e",
                            if view.prices == PriceView::AllPrices {
                                "All prices"
                            } else {
                                "Within budget"
                            },
                            money(&catalog.ceiling)
                        ),
                        2,
                    ));
                    lines.push((String::new(), 0));
                    let nw = width.saturating_sub(30);
                    lines.push((
                        format!(
                            "  {:<nw$} {:>4} {:>5} {:>7} {:>8}",
                            "machine", "vCPU", "RAM", "disk", "/day"
                        ),
                        2,
                    ));
                    for (i, m) in available.iter().enumerate().skip(view.top).take(count) {
                        lines.push((
                            format!(
                                "{} {:<nw$} {:>4} {:>5} {:>7} {:>8}",
                                if i == view.index { ">" } else { " " },
                                clip(&m.id, nw),
                                m.cpu,
                                m.memory,
                                m.disk,
                                money(&m.daily)
                            ),
                            if i == view.index { 3 } else { 0 },
                        ));
                    }
                    if available.is_empty() {
                        lines.push((
                            "No options within this budget. b shows all prices.".into(),
                            0,
                        ));
                    }
                }
            } else {
                lines.push(("Available".into(), 1));
                lines.push((
                    if loading {
                        "Loading catalog in the background..."
                    } else {
                        "Catalog unavailable. r retries."
                    }
                    .into(),
                    2,
                ));
            }
        } else if !view.detail {
            let managed = data.machines.iter().filter(|m| m.managed).count();
            let needs_review = data
                .machines
                .iter()
                .filter(|m| !m.managed && !m.finished)
                .count();
            let retained = data.machines.len().saturating_sub(managed + needs_review);
            lines.push((
                format!(
                    "Tasks   {} active   {} managed   {} review   {} retained",
                    data.machines.iter().filter(|m| m.active).count(),
                    managed,
                    needs_review,
                    retained
                ),
                1,
            ));
            lines.push((
                format!("{}   sorted by {}", FILTERS[view.filter], SORTS[view.sort]),
                2,
            ));
            lines.push((String::new(), 0));
            let nw = width.saturating_sub(36);
            let row = |name: &str, phase: &str, left: &str, paid: &str| {
                format!(
                    "{:<nw$} {:<12} {:<11} {:>8}",
                    clip(name, nw),
                    clip(phase, 12),
                    clip(left, 11),
                    paid
                )
            };
            lines.push((
                format!("  {}", row("task", "state", "time left", "paid")),
                2,
            ));
            for (i, item) in grouped(data, view)
                .iter()
                .enumerate()
                .skip(view.top)
                .take(count)
            {
                let text =
                    match item {
                        Row::Group(group, count) => format!(
                            "{} {} {} ({count})",
                            if i == view.index { ">" } else { " " },
                            if view.collapsed.contains(group) {
                                "+"
                            } else {
                                "-"
                            },
                            group.title()
                        ),
                        Row::Machine(m) => format!(
                            "{} {}",
                            if i == view.index { ">" } else { " " },
                            row(
                                &format!(
                                    "  {}{}",
                                    m.experiment.as_ref().map_or(
                                        String::new(),
                                        |experiment| format!("[{}] ", experiment.role)
                                    ),
                                    m.name
                                ),
                                if m.unresolved { "unresolved" } else { &m.phase },
                                &remaining(m),
                                &m.paid
                            )
                        ),
                    };
                lines.push((
                    text,
                    if i == view.index {
                        3
                    } else if matches!(item, Row::Group(..)) {
                        1
                    } else {
                        0
                    },
                ));
            }
            if length == 0 {
                lines.push(("No tasks yet. Start with fission help run.".into(), 0));
            }
        } else if let Some(m) = selected(data, view) {
            lines.push((m.name.clone(), 1));
            lines.push((
                format!("{}   {}   {}", m.phase, remaining(m), m.provider),
                2,
            ));
            if m.provider_warning {
                lines.push(("Provider history warning: verify availability.".into(), 2));
            }
            lines.push((String::new(), 0));
            lines.push((m.capacity.clone(), 0));
            if let Some(experiment) = &m.experiment {
                lines.push((
                    format!("Experiment {}   role {}", experiment.name, experiment.role),
                    0,
                ));
            }
            lines.push((m.task_detail.clone(), 0));
            lines.push((format!("Started  {}", m.started), 0));
            lines.push((
                format!(
                    "{}  {}",
                    if m.finished {
                        "Closed "
                    } else if m.managed {
                        "Deadline"
                    } else {
                        "Expires"
                    },
                    m.ended
                ),
                0,
            ));
            lines.push((
                format!(
                    "Paid {}   budget {}   quote {} USDC.e",
                    m.paid, m.cap, m.quote
                ),
                0,
            ));
            lines.push((String::new(), 0));
            lines.push(("Transactions   USDC.e".into(), 1));
            let count = height
                .saturating_sub(
                    17 + usize::from(m.experiment.is_some()) + usize::from(m.provider_warning),
                )
                .max(1);
            for tx in m.transactions.iter().skip(view.offset).take(count) {
                lines.push((
                    format!(
                        "{:<10} {:<10} {}",
                        tx.paid,
                        clip(&tx.operation, 10),
                        tx.hash
                    ),
                    0,
                ));
            }
            if m.transactions.is_empty() {
                lines.push(("No recorded receipts.".into(), 2));
            }
        }
        lines.truncate(height - 4);
        lines.resize(height - 4, (String::new(), 0));
        let status = if !view.message.is_empty() {
            view.message.clone()
        } else if view.storage {
            "Directory storage, managed by you.".into()
        } else if view.available {
            if view.prices == PriceView::Gateways {
                "Advisory prices have different billing units; not comparable VM quotes.".into()
            } else {
                data.available.as_ref().map_or_else(String::new, |c| {
                    format!(
                        "{} {} UTC   GiB   USDC.e/day",
                        if loading { "Refreshing" } else { "Updated" },
                        c.fetched_at
                            .replace('T', " ")
                            .chars()
                            .skip(5)
                            .take(11)
                            .collect::<String>()
                    )
                })
            }
        } else if view.detail {
            selected(data, view).map_or_else(String::new, |m| {
                if m.exported.is_empty() {
                    String::new()
                } else {
                    format!("Saved {}", m.exported)
                }
            })
        } else {
            data.spending.clone()
        };
        lines.push((status, 2));
        if busy {
            lines.push((
                "Working... qq exits after the operation finishes.".into(),
                2,
            ));
        } else if view.confirm.is_some() {
            buttons(
                &mut lines,
                &mut hits,
                &[
                    ("[n Keep running]", KeyCode::Char('n')),
                    ("[y Stop and destroy]", KeyCode::Char('y')),
                ],
            );
        } else if view.help || view.storage {
            buttons(&mut lines, &mut hits, &[("[Esc Back]", KeyCode::Esc)]);
        } else if view.detail {
            if view.available && view.prices == PriceView::Gateways {
                buttons(
                    &mut lines,
                    &mut hits,
                    &[("[h Back]", KeyCode::Esc), ("[b View]", KeyCode::Char('b'))],
                );
            } else if view.available {
                buttons(
                    &mut lines,
                    &mut hits,
                    &[
                        ("[h Back]", KeyCode::Esc),
                        ("[Enter Quote]", KeyCode::Enter),
                        ("[[ Prev]", KeyCode::Char('[')),
                        ("[Next ]]", KeyCode::Char(']')),
                    ],
                );
            } else {
                let ssh = if selected(data, view).is_some_and(|machine| machine.ssh) {
                    "[SSH terminal]"
                } else {
                    "[SSH unavailable]"
                };
                buttons(
                    &mut lines,
                    &mut hits,
                    &[
                        ("[h Back]", KeyCode::Esc),
                        (ssh, KeyCode::Enter),
                        ("[p Check]", KeyCode::Char('p')),
                        ("[u Resume]", KeyCode::Char('u')),
                        ("[x Stop]", KeyCode::Char('x')),
                    ],
                );
            }
        } else {
            buttons(
                &mut lines,
                &mut hits,
                &[
                    ("[Enter Open]", KeyCode::Enter),
                    (
                        if view.available {
                            "[b Prices/Gateways]"
                        } else {
                            "[f Filter]"
                        },
                        KeyCode::Char(if view.available { 'b' } else { 'f' }),
                    ),
                    ("[r Refresh]", KeyCode::Char('r')),
                ],
            );
        }
        lines.push(if view.quit_pending {
            ("Press q again to quit; any other key cancels.".into(), 1)
        } else {
            (
                "j/k move  h/l back/open  Tab tabs  ? help  qq quit".into(),
                2,
            )
        });
    }
    let mut out = Vec::new();
    for y in 0..height {
        queue!(
            out,
            MoveTo(0, y as u16),
            SetAttribute(Attribute::Reset),
            ResetColor,
            Clear(ClearType::CurrentLine)
        )?;
        if let Some((text, style)) = lines.get(y) {
            if env::var_os("NO_COLOR").is_none() {
                match style {
                    1 => queue!(out, SetForegroundColor(Color::AnsiValue(108)))?,
                    2 => queue!(out, SetAttribute(Attribute::Dim))?,
                    3 => queue!(out, SetAttribute(Attribute::Reverse))?,
                    _ => (),
                }
            }
            queue!(out, Print(format!("  {}", clip(text, width))))?;
        }
    }
    if out != *previous {
        stdout().write_all(&out)?;
        stdout().flush()?;
        *previous = out;
    }
    Ok(hits)
}

struct Worker {
    receiver: mpsc::Receiver<Result<Snapshot, String>>,
    // Dropping a catalog worker closes its pipe, so Node cancels outstanding GETs.
    _input: Option<ChildStdin>,
}

struct PopupWorker {
    receiver: mpsc::Receiver<Result<(), String>>,
}

fn fetch(node: String, bridge: String, action: &str, name: &str) -> Worker {
    let (tx, receiver) = mpsc::channel();
    let mut command = Command::new(node);
    command
        .args([bridge.as_str(), action, name])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if action == "catalog" {
        command
            .env("FISSION_UI_BACKGROUND", "1")
            .stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = tx.send(Err(error.to_string()));
            return Worker {
                receiver,
                _input: None,
            };
        }
    };
    let input = child.stdin.take();
    thread::spawn(move || {
        let result = (|| {
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            serde_json::from_slice(&output.stdout)
                .map_err(|e| format!("Cannot read local state: {e}"))
        })();
        let _ = tx.send(result);
    });
    Worker {
        receiver,
        _input: input,
    }
}

fn open_popup(node: String, helper: String, name: String) -> PopupWorker {
    let (tx, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = Command::new(node)
            .args([helper, "popup".into(), name])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| error.to_string())
            .and_then(|output| {
                if output.status.success() && output.stdout == b"{\"status\":0}\n" {
                    Ok(())
                } else {
                    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    Err(if error.is_empty() {
                        "The tmux popup helper did not confirm startup.".into()
                    } else {
                        error
                    })
                }
            });
        let _ = tx.send(result);
    });
    PopupWorker { receiver }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    if !io::stdin().is_terminal() || !stdout().is_terminal() {
        return Err(
            "Open fission in an interactive terminal; use fission help for commands.".into(),
        );
    }
    let mut args = env::args().skip(1);
    let node = args.next().ok_or("Launch with fission.")?;
    let bridge = args.next().ok_or("Launch with fission.")?;
    let cli = PathBuf::from(&bridge).with_file_name("cli.mjs");
    let tmux_helper = PathBuf::from(&bridge).with_file_name("tmux.mjs");
    let interrupted = Arc::new(AtomicBool::new(false));
    let terminated = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, interrupted.clone())?;
    flag::register(SIGTERM, terminated.clone())?;
    let mut screen = Some(Screen::enter()?);
    let mut data = Snapshot::default();
    let mut view = View {
        sort: 1,
        message: "Loading local tasks...".into(),
        ..View::default()
    };
    let mut pending = Some(fetch(node.clone(), bridge.clone(), "snapshot", ""));
    let mut popup_pending: Option<PopupWorker> = None;
    let mut catalog_pending = Some(fetch(node.clone(), bridge.clone(), "catalog", ""));
    let mut catalog_error = String::new();
    let mut last_load = Instant::now();
    let mut quitting = false;
    let mut previous = Vec::new();
    loop {
        if interrupted.load(Ordering::Relaxed) || terminated.load(Ordering::Relaxed) {
            view.quit_pending = false;
            quitting = true;
        }
        if let Some(rx) = &pending {
            match rx.receiver.try_recv() {
                Ok(result) => {
                    let previous_selection = selection(&data, &view);
                    match result {
                        Ok(mut new) => {
                            let cue = (!data.machines.is_empty())
                                .then(|| snapshot_cue(&data, &new))
                                .flatten();
                            let operation_message = new.message.clone();
                            if new.available.as_ref().is_none_or(|incoming| {
                                data.available
                                    .as_ref()
                                    .is_some_and(|current| incoming.fetched_at < current.fetched_at)
                            }) {
                                new.available = data.available.take();
                            }
                            data = new;
                            if view.available {
                                view.index = view
                                    .index
                                    .min(available_count(&data, &view).saturating_sub(1));
                            } else {
                                restore_selection(&data, &mut view, previous_selection);
                                view.offset = view.offset.min(
                                    selected(&data, &view)
                                        .map_or(0, |m| m.transactions.len().saturating_sub(1)),
                                );
                            }
                            if !operation_message.is_empty() {
                                view.message = operation_message;
                                view.message_sticky = true;
                            } else if let Some(cue) = cue {
                                view.message = cue;
                                view.message_sticky = true;
                                stdout().write_all(b"\x07")?;
                                stdout().flush()?;
                            } else if !view.message_sticky {
                                view.message.clear();
                            }
                        }
                        Err(error) => {
                            view.message = error;
                            view.message_sticky = true;
                        }
                    }
                    pending = None;
                    last_load = Instant::now();
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    pending = None;
                    view.message = "Local state worker stopped.".into();
                }
                Err(mpsc::TryRecvError::Empty) => (),
            }
        }
        if let Some(worker) = &popup_pending {
            match worker.receiver.try_recv() {
                Ok(Ok(())) => {
                    view.message = "SSH popup closed; dashboard remained active.".into();
                    view.message_sticky = true;
                    popup_pending = None;
                }
                Ok(Err(error)) => {
                    view.message = error;
                    view.message_sticky = true;
                    popup_pending = None;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    view.message = "SSH popup worker stopped.".into();
                    view.message_sticky = true;
                    popup_pending = None;
                }
                Err(mpsc::TryRecvError::Empty) => (),
            }
        }
        if let Some(worker) = &catalog_pending {
            match worker.receiver.try_recv() {
                Ok(result) => {
                    match result {
                        Ok(new) => {
                            let selected_id =
                                offers(&data, &view).get(view.index).map(|m| m.id.clone());
                            data.available = new.available;
                            if view.available && view.prices != PriceView::Gateways {
                                view.index = offers(&data, &view)
                                    .iter()
                                    .position(|m| Some(&m.id) == selected_id.as_ref())
                                    .unwrap_or(0);
                                if selected_id.is_some()
                                    && offers(&data, &view).get(view.index).map(|m| &m.id)
                                        != selected_id.as_ref()
                                {
                                    view.detail = false;
                                }
                                view.region = 0;
                            }
                            catalog_error.clear();
                        }
                        Err(error) => catalog_error = format!("Catalog refresh failed: {error}"),
                    }
                    catalog_pending = None;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    catalog_pending = None;
                    catalog_error = "Catalog worker stopped. r retries.".into();
                }
                Err(mpsc::TryRecvError::Empty) => (),
            }
        }
        if quitting && pending.is_none() {
            break;
        }
        if view.available && view.message.is_empty() && !catalog_error.is_empty() {
            view.message = catalog_error.clone();
        }
        let hits = render(
            &data,
            &mut view,
            pending.is_some(),
            catalog_pending.is_some(),
            &mut previous,
        )?;
        if event::poll(Duration::from_millis(250))? {
            let input = event::read()?;
            if matches!(
                input,
                Event::Mouse(mouse)
                    if matches!(
                        mouse.kind,
                        MouseEventKind::Down(_) | MouseEventKind::Drag(_)
                            | MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                            | MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight
                    )
            ) {
                view.quit_pending = false;
            }
            let mut key = match input {
                Event::Key(key) => key,
                Event::Mouse(mouse) if pending.is_none() => {
                    let code = match mouse.kind {
                        MouseEventKind::ScrollUp => KeyCode::Up,
                        MouseEventKind::ScrollDown => KeyCode::Down,
                        MouseEventKind::Down(MouseButton::Left) => {
                            if let Some(hit) = hits.iter().find(|hit| {
                                hit.row == mouse.row && (hit.start..hit.end).contains(&mouse.column)
                            }) {
                                if view.confirm.is_some()
                                    && !matches!(hit.key, KeyCode::Char('y' | 'n'))
                                {
                                    continue;
                                }
                                hit.key
                            } else if !view.detail
                                && !view.help
                                && !view.storage
                                && view.confirm.is_none()
                            {
                                let (_, height) = terminal::size()?;
                                let count = usize::from(height).saturating_sub(12).max(1);
                                let row = usize::from(mouse.row);
                                let length = if view.available {
                                    available_count(&data, &view)
                                } else {
                                    grouped(&data, &view).len()
                                };
                                let index = view.top + row.saturating_sub(7);
                                if row < 7 || row >= 7 + count || index >= length {
                                    continue;
                                }
                                view.index = index;
                                KeyCode::Enter
                            } else {
                                continue;
                            }
                        }
                        _ => continue,
                    };
                    KeyEvent::new(code, KeyModifiers::NONE)
                }
                _ => continue,
            };
            if key.kind == KeyEventKind::Release {
                continue;
            }
            if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                view.quit_pending = false;
                quitting = true;
                view.message = "Finishing the current operation...".into();
                continue;
            }
            if quit_key(&mut view.quit_pending, &key) {
                quitting = true;
                view.message = "Finishing the current operation...".into();
                continue;
            }
            if key.code == KeyCode::Char('q') {
                view.g_pending = false;
                continue;
            }
            if pending.is_some() || quitting {
                continue;
            }
            if view.confirm.is_none() {
                if matches!(
                    key.code,
                    KeyCode::Char('a' | '1' | '2') | KeyCode::Tab | KeyCode::BackTab
                ) {
                    view.storage = false;
                    view.help = false;
                }
                if key.code == KeyCode::Char('o') {
                    view.storage = !view.storage;
                    view.help = false;
                    continue;
                }
                if view.storage {
                    if matches!(key.code, KeyCode::Esc | KeyCode::Char('h')) {
                        view.storage = false;
                    }
                    continue;
                }
                if key.code == KeyCode::Char('?') {
                    view.help = !view.help;
                    continue;
                }
                if view.help {
                    if matches!(key.code, KeyCode::Esc | KeyCode::Char('h')) {
                        view.help = false;
                    }
                    continue;
                }
                if !view.available && !view.detail {
                    let rows = grouped(&data, &view);
                    if matches!(key.code, KeyCode::Left | KeyCode::Char('h')) {
                        match rows.get(view.index) {
                            Some(Row::Group(group, _)) => {
                                view.collapsed.insert(group.clone());
                            }
                            Some(Row::Machine(m)) => {
                                let parent = group_key(m);
                                view.index = rows
                                    .iter()
                                    .position(|row| matches!(row, Row::Group(group, _) if *group == parent))
                                    .unwrap_or(view.index);
                            }
                            None => (),
                        }
                        continue;
                    }
                    if matches!(key.code, KeyCode::Right | KeyCode::Char('l'))
                        && let Some(Row::Group(group, _)) = rows.get(view.index)
                    {
                        if !view.collapsed.remove(group) {
                            view.index = (view.index + 1).min(rows.len().saturating_sub(1));
                        }
                        continue;
                    }
                }
                if matches!(key.code, KeyCode::Left | KeyCode::Char('h')) {
                    key.code = KeyCode::Esc;
                }
                if matches!(key.code, KeyCode::Right | KeyCode::Char('l')) && !view.detail {
                    key.code = KeyCode::Enter;
                }
                if !view.detail {
                    let length = if view.available {
                        available_count(&data, &view)
                    } else {
                        grouped(&data, &view).len()
                    };
                    let half = usize::from(terminal::size()?.1).saturating_sub(12).max(2) / 2;
                    let first = key.code == KeyCode::Home
                        || (key.code == KeyCode::Char('g') && view.g_pending);
                    view.g_pending = key.code == KeyCode::Char('g') && !view.g_pending;
                    if first {
                        view.index = 0;
                        continue;
                    }
                    if matches!(key.code, KeyCode::End | KeyCode::Char('G')) {
                        view.index = length.saturating_sub(1);
                        continue;
                    }
                    if key.modifiers.contains(KeyModifiers::CONTROL) {
                        match key.code {
                            KeyCode::Char('d') => {
                                view.index = (view.index + half).min(length.saturating_sub(1));
                                continue;
                            }
                            KeyCode::Char('u') => {
                                view.index = view.index.saturating_sub(half);
                                continue;
                            }
                            _ => (),
                        }
                    }
                }
            }
            let rows = grouped(&data, &view);
            let selected = selected(&data, &view);
            let mut action = None;
            if let Some(name) = view.confirm.clone() {
                let (columns, height) = terminal::size()?;
                if columns < 56 || height < 16 {
                    if matches!(key.code, KeyCode::Char('n') | KeyCode::Esc) {
                        view.confirm = None;
                    }
                    continue;
                }
                match key.code {
                    KeyCode::Char('y') => {
                        view.confirm = None;
                        action = Some(("close", name));
                    }
                    KeyCode::Char('n') | KeyCode::Esc => view.confirm = None,
                    _ => continue,
                }
            } else if matches!(
                key.code,
                KeyCode::Char('a' | '1' | '2') | KeyCode::Tab | KeyCode::BackTab
            ) {
                view.available = match key.code {
                    KeyCode::Char('1') => false,
                    KeyCode::Char('2') => true,
                    _ => !view.available,
                };
                view.detail = false;
                view.index = 0;
                view.offset = 0;
                view.message.clear();
                view.top = 0;
                if view.available && data.available.is_none() && catalog_pending.is_none() {
                    action = Some(("catalog", String::new()));
                }
            } else if view.available {
                let rows = offers(&data, &view);
                match key.code {
                    KeyCode::Up | KeyCode::Char('k')
                        if view.detail && view.prices == PriceView::Gateways =>
                    {
                        view.offset = view.offset.saturating_sub(1);
                    }
                    KeyCode::Down | KeyCode::Char('j')
                        if view.detail && view.prices == PriceView::Gateways =>
                    {
                        view.offset = view.offset.saturating_add(1);
                    }
                    KeyCode::Up | KeyCode::Char('k') if !view.detail => {
                        view.index = view.index.saturating_sub(1)
                    }
                    KeyCode::Down | KeyCode::Char('j') if !view.detail => {
                        view.index =
                            (view.index + 1).min(available_count(&data, &view).saturating_sub(1))
                    }
                    KeyCode::Char('b') => {
                        view.prices = view.prices.next();
                        view.index = 0;
                        view.top = 0;
                        view.offset = 0;
                        view.detail = false;
                        view.message.clear();
                    }
                    KeyCode::Char('r') => action = Some(("catalog", String::new())),
                    KeyCode::Esc | KeyCode::Backspace => {
                        view.detail = false;
                        view.message.clear();
                    }
                    KeyCode::Char(']' | '[') if view.detail => {
                        if let Some(m) = rows.get(view.index) {
                            view.region = (view.region
                                + if key.code == KeyCode::Char('[') {
                                    m.regions.len().saturating_sub(1)
                                } else {
                                    1
                                })
                                % m.regions.len().max(1);
                            view.message.clear();
                        }
                    }
                    KeyCode::Enter => {
                        if view.prices == PriceView::Gateways {
                            // Gateway metadata is read-only, including implemented routes.
                            view.detail = data.gateways.get(view.index).is_some();
                            view.offset = 0;
                            view.message.clear();
                        } else if let Some(m) =
                            rows.get(view.index).filter(|m| !m.regions.is_empty())
                        {
                            if view.detail {
                                action = Some(("quote", serde_json::json!({"id": m.id, "region": m.regions[view.region % m.regions.len()]}).to_string()));
                            } else {
                                view.detail = true;
                                view.region = 0;
                                view.message.clear();
                            }
                        }
                    }
                    _ => (),
                }
            } else {
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => {
                        if view.detail {
                            view.offset = view.offset.saturating_sub(1);
                        } else {
                            view.index = view.index.saturating_sub(1);
                        }
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        if view.detail {
                            view.offset = (view.offset + 1).min(
                                selected.map_or(0, |m| m.transactions.len().saturating_sub(1)),
                            );
                        } else {
                            view.index = (view.index + 1).min(rows.len().saturating_sub(1));
                        }
                    }
                    KeyCode::Char('f') => {
                        view.filter = (view.filter + 1) % FILTERS.len();
                        view.index = 0;
                        view.detail = false;
                        view.offset = 0;
                    }
                    KeyCode::Char('s') if !view.detail => {
                        view.sort = (view.sort + 1) % SORTS.len();
                        view.index = 0;
                    }
                    KeyCode::Esc | KeyCode::Backspace => {
                        view.detail = false;
                        view.offset = 0;
                    }
                    KeyCode::Char('r') => action = Some(("snapshot", String::new())),
                    KeyCode::Char('v') => action = Some(("verify", String::new())),
                    KeyCode::Char('u') if view.detail => {
                        if let Some(m) = selected.filter(|m| m.managed && !m.finished) {
                            action = Some(("resume", m.name.clone()));
                        }
                    }
                    KeyCode::Char('p') if view.detail => {
                        if let Some(m) = selected.filter(|m| !m.finished) {
                            view.message =
                                format!("Checking {} (at most {} USDC.e)...", m.name, m.check_cap);
                            action = Some(("refresh", m.name.clone()));
                        }
                    }
                    KeyCode::Char('x') if view.detail => {
                        if let Some(m) = selected.filter(|m| !m.finished) {
                            view.confirm = Some(m.name.clone());
                        }
                    }
                    KeyCode::Enter => {
                        if !view.detail
                            && let Some(Row::Group(group, _)) = rows.get(view.index)
                        {
                            if !view.collapsed.remove(group) {
                                view.collapsed.insert(group.clone());
                            }
                            continue;
                        }
                        if let Some(m) = selected {
                            if !view.detail {
                                view.detail = true;
                                view.offset = 0;
                            } else if !m.ssh {
                                view.message = if m.finished {
                                    "This machine is closed."
                                } else if m.unresolved {
                                    "SSH unavailable; check preparation and cleanup status."
                                } else {
                                    "SSH opens when the full VM is ready."
                                }
                                .into();
                            } else if env::var_os("FISSION_TMUX_SESSION").is_some() {
                                if popup_pending.is_some() {
                                    view.message = "An SSH popup is already open.".into();
                                    view.message_sticky = true;
                                } else {
                                    popup_pending = Some(open_popup(
                                        node.clone(),
                                        tmux_helper.to_string_lossy().into_owned(),
                                        m.name.clone(),
                                    ));
                                    view.message = format!("Opening {} in a tmux popup...", m.name);
                                    view.message_sticky = false;
                                }
                            } else {
                                drop(screen.take());
                                let result = (|| -> io::Result<_> {
                                    let mut command = Command::new(&node);
                                    command.arg(&cli).args(["advanced", "ssh", &m.name]);
                                    let mut child = command.spawn()?;
                                    let mut stopping = false;
                                    loop {
                                        if terminated.load(Ordering::Relaxed) && !stopping {
                                            // The CLI's SIGTERM handler shuts down its owned SSH process.
                                            Command::new("kill")
                                                .args(["-TERM", &child.id().to_string()])
                                                .status()?;
                                            stopping = true;
                                        }
                                        if let Some(status) = child.try_wait()? {
                                            break Ok(status);
                                        }
                                        thread::sleep(Duration::from_millis(100));
                                    }
                                })();
                                interrupted.store(false, Ordering::Relaxed);
                                screen = Some(Screen::enter()?);
                                previous.clear();
                                view.message = match result {
                                    Ok(status) => format!("SSH exited {status}."),
                                    Err(error) => error.to_string(),
                                };
                                view.message_sticky = true;
                                last_load = Instant::now();
                            }
                        }
                    }
                    _ => (),
                }
            }
            if let Some((action, name)) = action {
                if action != "refresh" {
                    view.message = match action {
                        "close" => format!("Requesting cleanup for {name}..."),
                        "resume" => format!("Resuming {name}..."),
                        "verify" => "Verifying payment receipts...".into(),
                        "catalog" => "Loading available machines...".into(),
                        "quote" => "Fetching a fresh quote...".into(),
                        _ => "Reloading local state...".into(),
                    };
                    view.message_sticky = false;
                }
                if action == "catalog" {
                    if catalog_pending.is_none() {
                        catalog_pending = Some(fetch(node.clone(), bridge.clone(), action, &name));
                    }
                    view.message.clear();
                    catalog_error.clear();
                } else {
                    pending = Some(fetch(node.clone(), bridge.clone(), action, &name));
                }
            }
        }
        if pending.is_none()
            && !quitting
            && !view.available
            && view.confirm.is_none()
            && last_load.elapsed() >= Duration::from_secs(5)
        {
            pending = Some(fetch(node.clone(), bridge.clone(), "snapshot", ""));
        }
    }
    drop(screen);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("fission: {}", clip(&error.to_string(), 500));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(
        name: &str,
        managed: bool,
        finished: bool,
        active: bool,
        experiment: Option<(&str, &str)>,
    ) -> Machine {
        Machine {
            name: name.into(),
            active,
            unresolved: !finished && !active,
            phase: if finished { "succeeded" } else { "preparing" }.into(),
            provider: "compute-mpp".into(),
            provider_warning: false,
            finished,
            ssh: false,
            requested: "2026-09-15T00:00:00Z".into(),
            expiry: None,
            estimated: false,
            paid: "0.22".into(),
            paid_units: Some("220000".into()),
            capacity: "1 vCPU / 1 GiB RAM / 25 GiB disk".into(),
            started: "2026-09-15 00:00 UTC".into(),
            ended: "2026-09-15 01:00 UTC".into(),
            cap: "0.25".into(),
            quote: "0.22".into(),
            exported: String::new(),
            check_cap: "0".into(),
            managed,
            experiment: experiment.map(|(name, role)| Experiment {
                name: name.into(),
                role: role.into(),
            }),
            task_detail: String::new(),
            transactions: Vec::new(),
        }
    }

    fn snapshot(machines: Vec<Machine>) -> Snapshot {
        Snapshot {
            machines,
            ..Snapshot::default()
        }
    }

    #[test]
    fn gateway_view_never_exposes_quotable_offers_and_works_without_catalog() {
        let mut data: Snapshot = serde_json::from_value(serde_json::json!({
            "machines": [], "spending": "", "message": "",
            "gateways": [{"id": "modal-tempo", "gateway": "Tempo", "operator": "Modal"}],
            "available": {"ceiling": "0.25", "fetchedAt": "2026-09-15T00:00:00Z", "machines": [
                {"id": "cheap", "provider": "compute-mpp", "operator": "vultr", "providerWarning": false,
                 "cpu": 1, "memory": 2, "disk": 50, "daily": "0.22", "regions": ["ams"], "withinCap": true},
                {"id": "expensive", "provider": "compute-mpp", "operator": "vultr", "providerWarning": false,
                 "cpu": 4, "memory": 8, "disk": 100, "daily": "1", "regions": ["ams"], "withinCap": false}
            ]}
        })).unwrap();
        let mut view = View::default();
        assert_eq!(offers(&data, &view)[0].id, "cheap");
        assert_eq!(available_count(&data, &view), 1);
        view.prices = view.prices.next();
        assert_eq!(available_count(&data, &view), 2);
        view.prices = view.prices.next();
        assert!(offers(&data, &view).is_empty());
        assert_eq!(available_count(&data, &view), 1);
        data.available = None;
        assert_eq!(available_count(&data, &view), 1);
        view.prices = view.prices.next();
        assert_eq!(available_count(&data, &view), 0);
    }

    #[test]
    fn tasks_show_managed_and_nonclosed_records_and_group_experiments() {
        let data = snapshot(vec![
            machine("pair-tests", true, true, false, Some(("pair", "tests"))),
            machine("pair-build", true, true, false, Some(("pair", "build"))),
            machine("standalone", true, true, false, None),
            machine("needs-review", false, false, false, None),
            machine("old-workspace", false, true, false, None),
        ]);
        let view = View::default();

        assert_eq!(machines(&data, &view).len(), 4);
        let rows = grouped(&data, &view);
        assert!(matches!(rows[0], Row::Group(GroupKey::NeedsReview, 1)));
        assert!(matches!(rows[2], Row::Group(GroupKey::Experiment(ref name), 2) if name == "pair"));
        assert!(matches!(rows[5], Row::Group(GroupKey::Managed, 1)));
        assert!(!rows.iter().any(|row| {
            matches!(row, Row::Machine(machine) if machine.name == "old-workspace")
        }));
    }

    #[test]
    fn all_records_exposes_retained_workspaces_but_starts_them_collapsed() {
        let data = snapshot(vec![
            machine("managed", true, true, false, None),
            machine("old-workspace", false, true, false, None),
        ]);
        let mut view = View {
            filter: 2,
            ..View::default()
        };

        assert!(view.collapsed.contains(&GroupKey::Retained));
        assert!(!grouped(&data, &view).iter().any(|row| {
            matches!(row, Row::Machine(machine) if machine.name == "old-workspace")
        }));
        view.collapsed.remove(&GroupKey::Retained);
        assert!(grouped(&data, &view).iter().any(|row| {
            matches!(row, Row::Machine(machine) if machine.name == "old-workspace")
        }));
    }

    #[test]
    fn refresh_never_retargets_hidden_machine_details() {
        let data = snapshot(vec![machine("needs-review", false, false, false, None)]);
        let mut view = View {
            index: 1,
            detail: true,
            ..View::default()
        };
        let previous = selection(&data, &view);
        assert_eq!(previous, Some(Selection::Machine("needs-review".into())));

        let closed = snapshot(vec![machine("needs-review", false, true, false, None)]);
        restore_selection(&closed, &mut view, previous);
        assert!(!view.detail);
        assert_eq!(view.offset, 0);
        assert!(selected(&closed, &view).is_none());
    }

    #[test]
    fn snapshot_cues_report_state_transitions_without_new_record_noise() {
        let mut before_ready = machine("ready-one", true, false, false, None);
        let mut after_ready = machine("ready-one", true, false, true, None);
        after_ready.ssh = true;
        let mut before_finished = machine("done-one", true, false, true, None);
        let after_finished = machine("done-one", true, true, false, None);
        let before_not_rented = machine("skipped-one", true, false, false, None);
        let mut after_not_rented = machine("skipped-one", true, true, false, None);
        after_not_rented.phase = "not_purchased".into();
        before_ready.ssh = false;
        before_finished.finished = false;

        let cue = snapshot_cue(
            &snapshot(vec![before_ready, before_finished, before_not_rented]),
            &snapshot(vec![
                after_ready,
                after_finished,
                after_not_rented,
                machine("new-history", true, true, false, None),
            ]),
        )
        .unwrap();

        assert!(cue.contains("Ready: ready-one"));
        assert!(cue.contains("Finished: done-one (succeeded)"));
        assert!(cue.contains("Not rented: skipped-one"));
        assert!(!cue.contains("new-history"));
        assert!(
            snapshot_cue(
                &Snapshot::default(),
                &snapshot(vec![machine("first-load", true, false, true, None,)])
            )
            .is_none()
        );
    }

    #[test]
    fn quit_requires_two_consecutive_nonrepeat_q_presses() {
        let q = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        let other = KeyEvent::new(KeyCode::Down, KeyModifiers::NONE);
        let repeat =
            KeyEvent::new_with_kind(KeyCode::Char('q'), KeyModifiers::NONE, KeyEventKind::Repeat);
        let release = KeyEvent::new_with_kind(
            KeyCode::Char('x'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        let mut pending = false;

        assert!(!quit_key(&mut pending, &q));
        assert!(pending);
        assert!(!quit_key(&mut pending, &repeat));
        assert!(pending);
        assert!(!quit_key(&mut pending, &release));
        assert!(pending);
        assert!(!quit_key(&mut pending, &other));
        assert!(!pending);
        assert!(!quit_key(&mut pending, &q));
        assert!(quit_key(&mut pending, &q));
        assert!(!pending);
    }
}
