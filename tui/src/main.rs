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
    storage: Option<Storage>,
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
    project: String,
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
    transactions: Vec<Transaction>,
}

#[derive(Deserialize)]
struct Transaction {
    paid: String,
    operation: String,
    hash: String,
}

#[derive(Default)]
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
    confirm: Option<String>,
    message: String,
    available: bool,
    all_prices: bool,
    region: usize,
    collapsed: BTreeSet<String>,
}

fn offers<'a>(data: &'a Snapshot, view: &View) -> Vec<&'a Offer> {
    data.available.as_ref().map_or_else(Vec::new, |catalog| {
        catalog
            .machines
            .iter()
            .filter(|m| view.all_prices || m.within_cap)
            .collect()
    })
}

const FILTERS: [&str; 3] = ["all", "active", "history"];
const SORTS: [&str; 4] = ["recent", "name", "paid", "expiry"];

fn machines<'a>(data: &'a Snapshot, view: &View) -> Vec<&'a Machine> {
    let mut rows: Vec<_> = data
        .machines
        .iter()
        .filter(|m| match view.filter {
            1 => m.active,
            2 => !m.active,
            _ => true,
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

enum Row<'a> {
    Project(&'a str, usize),
    Machine(&'a Machine),
}

fn grouped<'a>(data: &'a Snapshot, view: &View) -> Vec<Row<'a>> {
    let mut projects: BTreeMap<&str, Vec<&Machine>> = BTreeMap::new();
    for machine in machines(data, view) {
        projects.entry(&machine.project).or_default().push(machine);
    }
    let mut rows = Vec::new();
    for (project, machines) in projects {
        rows.push(Row::Project(project, machines.len()));
        if !view.collapsed.contains(project) {
            rows.extend(machines.into_iter().map(Row::Machine));
        }
    }
    rows
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
        lines.push(("fission".into(), 1));
        lines.push(("Enlarge the terminal to at least 56 x 16.".into(), 0));
        lines.push(("q quit".into(), 2));
    } else {
        lines.push((String::new(), 0));
        buttons(
            &mut lines,
            &mut hits,
            &[
                ("fission", KeyCode::Null),
                (
                    if view.available {
                        " My machines "
                    } else {
                        "[My machines]"
                    },
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
            offers(data, view).len()
        } else {
            grouped(data, view).len()
        };
        view.index = view.index.min(length.saturating_sub(1));
        view.top = view.top.min(length.saturating_sub(count)).min(view.index);
        if view.index >= view.top + count {
            view.top = view.index + 1 - count;
        }
        if view.storage {
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
                ("Tab or 1/2 switch tabs   q quit", 0),
                ("Click to open; wheel moves one row.", 2),
                ("f filter   s sort   r refresh", 0),
                ("Available: b prices   [ / ] region", 0),
                ("Machine: Enter SSH   p check   x close", 0),
                ("v verify payments   ? close help", 0),
            ] {
                lines.push((text.into(), style));
            }
        } else if view.available {
            if let Some(catalog) = &data.available {
                let available = offers(data, view);
                if view.detail {
                    if let Some(m) = available.get(view.index) {
                        lines.push((
                            format!("{}{}", if m.provider_warning { "! " } else { "" }, m.id),
                            1,
                        ));
                        lines.push((format!("{}   Linux x86_64", m.provider), 2));
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
                    lines.push((format!("Available   {} options", available.len()), 1));
                    lines.push((
                        format!(
                            "{}   VM budget: {} USDC.e",
                            if view.all_prices {
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
                                clip(
                                    &format!(
                                        "{}{}",
                                        if m.provider_warning { "! " } else { "" },
                                        m.id
                                    ),
                                    nw
                                ),
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
            lines.push((
                format!(
                    "My machines   {} active   {} saved   {} unresolved",
                    data.machines.iter().filter(|m| m.active).count(),
                    data.machines.len(),
                    data.machines.iter().filter(|m| m.unresolved).count()
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
                format!("  {}", row("machine", "state", "time left", "paid")),
                2,
            ));
            for (i, item) in grouped(data, view)
                .iter()
                .enumerate()
                .skip(view.top)
                .take(count)
            {
                let text = match item {
                    Row::Project(project, count) => format!(
                        "{} {} {} ({count})",
                        if i == view.index { ">" } else { " " },
                        if view.collapsed.contains(*project) {
                            "+"
                        } else {
                            "-"
                        },
                        project
                    ),
                    Row::Machine(m) => format!(
                        "{} {}",
                        if i == view.index { ">" } else { " " },
                        row(
                            &format!("  {}{}", if m.provider_warning { "! " } else { "" }, m.name),
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
                    } else if matches!(item, Row::Project(..)) {
                        1
                    } else {
                        0
                    },
                ));
            }
            if length == 0 {
                lines.push(("No machines here yet.".into(), 0));
            }
        } else if let Some(m) = selected(data, view) {
            lines.push((m.name.clone(), 1));
            lines.push((
                format!(
                    "{}   {}   {}{}",
                    m.phase,
                    remaining(m),
                    m.provider,
                    if m.provider_warning { " !" } else { "" }
                ),
                2,
            ));
            lines.push((String::new(), 0));
            lines.push((m.capacity.clone(), 0));
            lines.push((format!("Started  {}", m.started), 0));
            lines.push((
                format!(
                    "{}  {}",
                    if m.finished { "Closed " } else { "Expires" },
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
            let count = height.saturating_sub(17).max(1);
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
            "Your disk. No recurring provider storage charge.".into()
        } else if view.available {
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
            lines.push(("Working... q exits after the operation finishes.".into(), 2));
        } else if view.confirm.is_some() {
            buttons(
                &mut lines,
                &mut hits,
                &[
                    ("[n Cancel]", KeyCode::Char('n')),
                    ("[y Save and close]", KeyCode::Char('y')),
                ],
            );
        } else if view.help || view.storage {
            buttons(&mut lines, &mut hits, &[("[Esc Back]", KeyCode::Esc)]);
        } else if view.detail {
            if view.available {
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
                buttons(
                    &mut lines,
                    &mut hits,
                    &[
                        ("[h Back]", KeyCode::Esc),
                        ("[SSH]", KeyCode::Enter),
                        ("[p Check]", KeyCode::Char('p')),
                        ("[x Close]", KeyCode::Char('x')),
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
                            "[b Prices]"
                        } else {
                            "[f Filter]"
                        },
                        KeyCode::Char(if view.available { 'b' } else { 'f' }),
                    ),
                    ("[r Refresh]", KeyCode::Char('r')),
                ],
            );
        }
        lines.push((
            "j/k move  h/l back/open  Tab tabs  ? help  q quit".into(),
            2,
        ));
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
    let interrupted = Arc::new(AtomicBool::new(false));
    let terminated = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, interrupted.clone())?;
    flag::register(SIGTERM, terminated.clone())?;
    let mut screen = Some(Screen::enter()?);
    let mut data = Snapshot::default();
    let mut view = View {
        sort: 1,
        message: "Loading local machines...".into(),
        ..View::default()
    };
    let mut pending = Some(fetch(node.clone(), bridge.clone(), "snapshot", ""));
    let mut catalog_pending = Some(fetch(node.clone(), bridge.clone(), "catalog", ""));
    let mut catalog_error = String::new();
    let mut last_load = Instant::now();
    let mut quitting = false;
    let mut previous = Vec::new();
    loop {
        quitting |= interrupted.load(Ordering::Relaxed) || terminated.load(Ordering::Relaxed);
        if let Some(rx) = &pending {
            match rx.receiver.try_recv() {
                Ok(result) => {
                    let previous_machine = selected(&data, &view).map(|m| m.name.clone());
                    match result {
                        Ok(mut new) => {
                            view.message = new.message.clone();
                            if data.machines.is_empty() && !new.machines.is_empty() {
                                view.collapsed =
                                    new.machines.iter().map(|m| m.project.clone()).collect();
                            }
                            if new.available.as_ref().is_none_or(|incoming| {
                                data.available
                                    .as_ref()
                                    .is_some_and(|current| incoming.fetched_at < current.fetched_at)
                            }) {
                                new.available = data.available.take();
                            }
                            data = new;
                            if view.available {
                                view.index =
                                    view.index.min(offers(&data, &view).len().saturating_sub(1));
                            } else {
                                let rows = grouped(&data, &view);
                                view.index = rows
                                    .iter()
                                    .position(|row| matches!(row, Row::Machine(m) if Some(&m.name) == previous_machine.as_ref()))
                                    .unwrap_or(view.index.min(rows.len().saturating_sub(1)));
                                view.offset = view.offset.min(
                                    selected(&data, &view)
                                        .map_or(0, |m| m.transactions.len().saturating_sub(1)),
                                );
                            }
                        }
                        Err(error) => view.message = error,
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
        if let Some(worker) = &catalog_pending {
            match worker.receiver.try_recv() {
                Ok(result) => {
                    match result {
                        Ok(new) => {
                            let selected_id =
                                offers(&data, &view).get(view.index).map(|m| m.id.clone());
                            data.available = new.available;
                            if view.available {
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
            let mut key = match event::read()? {
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
                                    offers(&data, &view).len()
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
            if key.code == KeyCode::Char('q')
                || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
            {
                quitting = true;
                view.message = "Finishing the current operation...".into();
                continue;
            }
            if pending.is_some() || quitting {
                continue;
            }
            if view.confirm.is_none() {
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
                            Some(Row::Project(project, _)) => {
                                view.collapsed.insert((*project).to_owned());
                            }
                            Some(Row::Machine(m)) => {
                                view.index = rows.iter().position(|row| matches!(row, Row::Project(project, _) if *project == m.project)).unwrap_or(view.index);
                            }
                            None => (),
                        }
                        continue;
                    }
                    if matches!(key.code, KeyCode::Right | KeyCode::Char('l'))
                        && let Some(Row::Project(project, _)) = rows.get(view.index)
                    {
                        if !view.collapsed.remove(*project) {
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
                        offers(&data, &view).len()
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
            if let Some(name) = view.confirm.take() {
                if key.code == KeyCode::Char('y') {
                    action = Some(("close", name));
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
                    KeyCode::Up | KeyCode::Char('k') if !view.detail => {
                        view.index = view.index.saturating_sub(1)
                    }
                    KeyCode::Down | KeyCode::Char('j') if !view.detail => {
                        view.index = (view.index + 1).min(rows.len().saturating_sub(1))
                    }
                    KeyCode::Char('b') => {
                        view.all_prices = !view.all_prices;
                        view.index = 0;
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
                        if let Some(m) = rows.get(view.index).filter(|m| !m.regions.is_empty()) {
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
                            && let Some(Row::Project(project, _)) = rows.get(view.index)
                        {
                            if !view.collapsed.remove(*project) {
                                view.collapsed.insert((*project).to_owned());
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
                                } else {
                                    "SSH opens when the full VM is ready."
                                }
                                .into();
                            } else {
                                drop(screen.take());
                                let result = (|| -> io::Result<_> {
                                    let mut command = Command::new(&node);
                                    command.arg(&cli).args(["ssh", &m.name]);
                                    if env::var_os("FISSION_TMUX_SESSION").is_some() {
                                        command.arg("--tmux");
                                    }
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
                        "close" => format!("Saving and closing {name}..."),
                        "verify" => "Verifying payment receipts...".into(),
                        "catalog" => "Loading available machines...".into(),
                        "quote" => "Fetching a fresh quote...".into(),
                        _ => "Reloading local state...".into(),
                    };
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
