use std::{
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
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Machine {
    name: String,
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
}

const FILTERS: [&str; 3] = ["all", "active", "past"];
const SORTS: [&str; 4] = ["recent", "name", "paid", "expiry"];

fn machines<'a>(data: &'a Snapshot, view: &View) -> Vec<&'a Machine> {
    let mut rows: Vec<_> = data
        .machines
        .iter()
        .filter(|m| match view.filter {
            1 => !m.finished,
            2 => m.finished,
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
        execute!(stdout(), EnterAlternateScreen, Hide)?;
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
        add("fission".into(), 1);
        add(
            format!(
                "{} active / {} recorded",
                data.machines.iter().filter(|m| !m.finished).count(),
                data.machines.len()
            ),
            2,
        );
        add(data.spending.clone(), 0);
        add(String::new(), 0);
        let rows = machines(data, view);
        if !view.detail {
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
            for (i, m) in rows.iter().enumerate().skip(offset).take(count) {
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
        } else if let Some(m) = rows.get(view.index) {
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
                "cached view / v verifies payments / paid includes token fees".into()
            } else {
                view.message.clone()
            },
            2,
        ));
        lines.push((
            if busy {
                "Operation in progress / q exits after it finishes".into()
            } else if let Some(name) = &view.confirm {
                format!("Close {name}? y save declared files and close / n cancel")
            } else if view.detail {
                "enter SSH / p check machine / x close / esc back / q quit".into()
            } else {
                "up/down select / enter details / tab filter / s sort / q quit".into()
            },
            2,
        ));
        lines.push((
            if view.detail {
                "up/down scroll receipts / r reload / v verify payments"
            } else {
                "r reload / v verify payments / ~ estimated expiry"
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
                    let selected = machines(&data, &view)
                        .get(view.index)
                        .map(|m| m.name.clone());
                    match result {
                        Ok(new) => {
                            view.message = new.message.clone();
                            data = new;
                            let rows = machines(&data, &view);
                            view.index = rows
                                .iter()
                                .position(|m| Some(&m.name) == selected.as_ref())
                                .unwrap_or(view.index.min(rows.len().saturating_sub(1)));
                            view.offset = view.offset.min(
                                rows.get(view.index)
                                    .map_or(0, |m| m.transactions.len().saturating_sub(1)),
                            );
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
            let Event::Key(key) = event::read()? else {
                continue;
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
            let rows = machines(&data, &view);
            let selected = rows.get(view.index).copied();
            let mut action = None;
            if let Some(name) = view.confirm.take() {
                if key.code == KeyCode::Char('y') {
                    action = Some(("close", name));
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
                                    let mut child = Command::new(&node)
                                        .arg(&cli)
                                        .args(["ssh", &m.name])
                                        .spawn()?;
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
                        _ => "Reloading local state...".into(),
                    };
                }
                pending = Some(fetch(node.clone(), bridge.clone(), action, &name));
            }
        }
        if pending.is_none()
            && !quitting
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
