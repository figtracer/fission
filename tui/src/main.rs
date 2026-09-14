use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    io::{self, IsTerminal, Write, stdout},
    path::PathBuf,
    process::{Command, Stdio},
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

fn render(data: &Snapshot, view: &View, busy: bool, previous: &mut Vec<u8>) -> io::Result<()> {
    let (columns, height) = terminal::size()?;
    let width = usize::from(columns.saturating_sub(4));
    let height = usize::from(height);
    let mut lines: Vec<(String, u8)> = Vec::new();
    let mut add = |text: String, style: u8| lines.push((text, style));
    if columns < 56 || height < 16 {
        add("fission".into(), 1);
        add("Enlarge the terminal to at least 56 x 16.".into(), 0);
        add("q quit".into(), 2);
    } else {
        add(String::new(), 0);
        add("fission   [my machines]   [available]".into(), 1);
        add(
            format!(
                "{} active / {} recorded / {} unresolved",
                data.machines.iter().filter(|m| m.active).count(),
                data.machines.len(),
                data.machines.iter().filter(|m| m.unresolved).count()
            ),
            2,
        );
        add(data.spending.clone(), 0);
        add(String::new(), 0);
        let rows = grouped(data, view);
        if view.available {
            add(
                format!(
                    "available / {} / daily catalog estimates in USDC.e",
                    if view.all_prices {
                        "all prices"
                    } else {
                        "within VM cap"
                    }
                ),
                2,
            );
            if let Some(catalog) = &data.available {
                let available = offers(data, view);
                add(
                    format!(
                        "VM cap {} / fetched {}",
                        catalog.ceiling, catalog.fetched_at
                    ),
                    2,
                );
                if view.detail {
                    if let Some(m) = available.get(view.index) {
                        add(
                            format!("{}{}", if m.provider_warning { "! " } else { "" }, m.id),
                            1,
                        );
                        add(format!("{} / Linux x86_64", m.provider), 0);
                        add(
                            format!(
                                "{} vCPU / {} GiB RAM / {} GiB disk",
                                m.cpu, m.memory, m.disk
                            ),
                            0,
                        );
                        add(format!("{} USDC.e / 24h estimate", m.daily), 0);
                        add(
                            format!(
                                "region {} / {} regions / g next",
                                m.regions[view.region % m.regions.len()],
                                m.regions.len()
                            ),
                            0,
                        );
                        add("enter fetches a fresh quote".into(), 2);
                        add(
                            "Agent plans choose the workload, duration, and budget.".into(),
                            2,
                        );
                    }
                } else {
                    add(
                        format!(
                            "  {:<30} {:>4} {:>7} {:>7} {:>10}",
                            "machine", "CPU", "RAM GiB", "disk GiB", "USDC.e/day"
                        ),
                        2,
                    );
                    let count = height.saturating_sub(14).max(1);
                    let offset = view.index / count * count;
                    for (i, m) in available.iter().enumerate().skip(offset).take(count) {
                        add(
                            format!(
                                "{} {:<30} {:>4} {:>7} {:>7} {:>10}",
                                if i == view.index { ">" } else { " " },
                                clip(
                                    &format!(
                                        "{}{}",
                                        if m.provider_warning { "! " } else { "" },
                                        m.id
                                    ),
                                    30
                                ),
                                m.cpu,
                                m.memory,
                                m.disk,
                                m.daily
                            ),
                            if i == view.index { 3 } else { 0 },
                        );
                    }
                    add(
                        format!(
                            "{} / {} options",
                            if available.is_empty() {
                                0
                            } else {
                                view.index + 1
                            },
                            available.len()
                        ),
                        2,
                    );
                    if available.is_empty() {
                        add(
                            "No catalog options in this view. b shows all prices.".into(),
                            0,
                        );
                    }
                }
            } else {
                add("r loads the available VM catalog".into(), 0);
            }
        } else if !view.detail {
            add(
                format!(
                    "{} machines    sort: {}",
                    FILTERS[view.filter], SORTS[view.sort]
                ),
                2,
            );
            let nw = if columns >= 100 { 24 } else { 16 };
            let sw = if columns >= 100 { 23 } else { 15 };
            let row = |name: &str, phase: &str, left: &str, paid: &str| {
                let base = format!(
                    "{:<nw$} {:<sw$} {:<12}",
                    clip(name, nw),
                    clip(phase, sw),
                    left
                );
                if columns >= 75 {
                    format!("{base} {paid:>9}")
                } else {
                    base
                }
            };
            add(
                format!("  {}", row("name", "state", "time left", "paid")),
                2,
            );
            let count = height.saturating_sub(12).max(1);
            let offset = view.index / count * count;
            for (i, item) in rows.iter().enumerate().skip(offset).take(count) {
                if let Row::Project(project, count) = item {
                    add(
                        format!(
                            "{} {} {} ({count})",
                            if i == view.index { ">" } else { " " },
                            if view.collapsed.contains(*project) {
                                "+"
                            } else {
                                "-"
                            },
                            project
                        ),
                        if i == view.index { 3 } else { 1 },
                    );
                    continue;
                }
                let Row::Machine(m) = item else {
                    unreachable!()
                };
                add(
                    format!(
                        "{}{}",
                        if i == view.index { "> " } else { "  " },
                        row(
                            &if m.provider_warning {
                                format!("! {}", m.name)
                            } else {
                                m.name.clone()
                            },
                            &m.phase,
                            &remaining(m),
                            &m.paid,
                        )
                    ),
                    if i == view.index { 3 } else { 0 },
                );
            }
            if rows.is_empty() {
                add("No machines here yet.".into(), 0);
            }
            if rows.len() > count {
                add(format!("{} / {}", view.index + 1, rows.len()), 2);
            }
        } else if let Some(m) = selected(data, view) {
            add(m.name.clone(), 1);
            add(
                format!(
                    "{} / {} / {}{}",
                    m.phase,
                    remaining(m),
                    m.provider,
                    if m.provider_warning { " !" } else { "" }
                ),
                0,
            );
            add(m.capacity.clone(), 2);
            add(format!("started {}", m.started), 0);
            add(
                format!(
                    "{} {}",
                    if m.finished { "closed" } else { "expires" },
                    m.ended
                ),
                0,
            );
            add(
                format!(
                    "paid {} / workspace cap {} / quote {}",
                    m.paid, m.cap, m.quote
                ),
                0,
            );
            add(String::new(), 0);
            add("transactions".into(), 2);
            let count = height.saturating_sub(19).max(1);
            for tx in m.transactions.iter().skip(view.offset).take(count) {
                add(
                    format!(
                        "{:<10} {:<10} {}",
                        tx.paid,
                        clip(&tx.operation, 10),
                        tx.hash
                    ),
                    0,
                );
            }
            if m.transactions.is_empty() {
                add("No recorded payment receipts.".into(), 0);
            } else {
                add(
                    format!(
                        "{}-{} of {} / full references: fission spending",
                        view.offset + 1,
                        (view.offset + count).min(m.transactions.len()),
                        m.transactions.len()
                    ),
                    2,
                );
            }
            if !m.exported.is_empty() {
                add(format!("saved {}", m.exported), 2);
            }
        }
        lines.truncate(height - 4);
        lines.resize(height - 4, (String::new(), 0));
        lines.push((
            if view.message.is_empty() {
                if view.available {
                    "Catalog estimates / plan and open verify terms before payment".into()
                } else {
                    "cached view / v verifies payments / paid includes token fees".into()
                }
            } else {
                view.message.clone()
            },
            2,
        ));
        lines.push((
            if busy {
                "Operation in progress / q exits after it finishes".into()
            } else if let Some(name) = &view.confirm {
                format!("[cancel] [save and close {name}] / n or y")
            } else if view.available {
                "[back] [details / quote] / enter select / q quit".into()
            } else if view.detail {
                "[back] [SSH] [check] [close] / enter SSH / q quit".into()
            } else {
                "up/down select / enter details / tab filter / s sort / q quit".into()
            },
            2,
        ));
        lines.push((
            if view.available {
                "[owned] [prices] [region] [reload] / a b g r"
            } else if view.detail {
                "up/down scroll receipts / r reload / v verify payments"
            } else {
                "a available / r reload / v verify payments / ~ estimated expiry"
            }
            .into(),
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
    Ok(())
}

fn fetch(
    node: String,
    bridge: String,
    action: &str,
    name: &str,
) -> mpsc::Receiver<Result<Snapshot, String>> {
    let (tx, rx) = mpsc::channel();
    let action = action.to_owned();
    let name = name.to_owned();
    thread::spawn(move || {
        let result = (|| {
            let output = Command::new(node)
                .args([bridge, action, name])
                .stdin(Stdio::null())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            serde_json::from_slice(&output.stdout)
                .map_err(|e| format!("Cannot read local state: {e}"))
        })();
        let _ = tx.send(result);
    });
    rx
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
    let mut last_load = Instant::now();
    let mut quitting = false;
    let mut previous = Vec::new();
    loop {
        quitting |= interrupted.load(Ordering::Relaxed) || terminated.load(Ordering::Relaxed);
        if let Some(rx) = &pending {
            match rx.try_recv() {
                Ok(result) => {
                    let previous_machine = selected(&data, &view).map(|m| m.name.clone());
                    match result {
                        Ok(mut new) => {
                            view.message = new.message.clone();
                            if data.machines.is_empty() && !new.machines.is_empty() {
                                view.collapsed =
                                    new.machines.iter().map(|m| m.project.clone()).collect();
                            }
                            if new.available.is_none() {
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
        if quitting && pending.is_none() {
            break;
        }
        render(&data, &view, pending.is_some(), &mut previous)?;
        if event::poll(Duration::from_millis(250))? {
            let key = match event::read()? {
                Event::Key(key) => key,
                Event::Mouse(mouse) if pending.is_none() => {
                    let code = match mouse.kind {
                        MouseEventKind::ScrollUp => KeyCode::Up,
                        MouseEventKind::ScrollDown => KeyCode::Down,
                        MouseEventKind::Down(MouseButton::Left) => {
                            let (_, height) = terminal::size()?;
                            if view.confirm.is_some() {
                                if mouse.row != height.saturating_sub(3) {
                                    continue;
                                }
                                if mouse.column < 11 {
                                    KeyCode::Char('n')
                                } else {
                                    KeyCode::Char('y')
                                }
                            } else if mouse.row == height.saturating_sub(3)
                                && (view.available || view.detail)
                            {
                                match mouse.column {
                                    2..9 => KeyCode::Esc,
                                    9..15 => KeyCode::Enter,
                                    15..23 if view.available => KeyCode::Enter,
                                    15..23 => KeyCode::Char('p'),
                                    23..30 if !view.available => KeyCode::Char('x'),
                                    _ => continue,
                                }
                            } else if view.available && mouse.row == height.saturating_sub(2) {
                                match mouse.column {
                                    2..10 => KeyCode::Char('a'),
                                    10..19 => KeyCode::Char('b'),
                                    19..28 => KeyCode::Char('g'),
                                    28..35 => KeyCode::Char('r'),
                                    _ => continue,
                                }
                            } else if mouse.row == 1 && (12..38).contains(&mouse.column) {
                                let available = mouse.column >= 27;
                                if available == view.available {
                                    continue;
                                }
                                KeyCode::Char('a')
                            } else if !view.detail {
                                let start = if view.available { 8 } else { 7 };
                                let count = usize::from(height)
                                    .saturating_sub(if view.available { 14 } else { 12 })
                                    .max(1);
                                let row = usize::from(mouse.row);
                                let length = if view.available {
                                    offers(&data, &view).len()
                                } else {
                                    grouped(&data, &view).len()
                                };
                                let index = view.index / count * count + row.saturating_sub(start);
                                if row < start || row >= start + count || index >= length {
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
            let rows = grouped(&data, &view);
            let selected = selected(&data, &view);
            let mut action = None;
            if let Some(name) = view.confirm.take() {
                if key.code == KeyCode::Char('y') {
                    action = Some(("close", name));
                }
            } else if key.code == KeyCode::Char('a') {
                view.available = !view.available;
                view.detail = false;
                view.index = 0;
                view.offset = 0;
                view.message.clear();
                if view.available && data.available.is_none() {
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
                    KeyCode::Char('g') if view.detail => {
                        if let Some(m) = rows.get(view.index) {
                            view.region = (view.region + 1) % m.regions.len();
                            view.message.clear();
                        }
                    }
                    KeyCode::Enter => {
                        if let Some(m) = rows.get(view.index) {
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
                    KeyCode::Tab => {
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
                pending = Some(fetch(node.clone(), bridge.clone(), action, &name));
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
