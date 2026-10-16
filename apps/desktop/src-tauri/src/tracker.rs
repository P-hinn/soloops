//! The overlay widget.
//!
//! A small window that sits on top of everything and says whether the clock
//! is running. Collapsed it is a pill at the edge of the screen; unfolded it
//! lists the projects of every client and starts the timer on one of them.
//!
//! Two things make it a widget rather than a window: it has no frame, and it
//! cannot be put down anywhere. Dragging moves it, letting go snaps it to one
//! of eight resting places — the four corners and the middle of the four
//! edges — so it ends up out of the way instead of in the middle of the text
//! being read.
//!
//! The arithmetic for that is at the top and takes no Tauri types, so the
//! part worth getting wrong can be tested without a screen.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

// --- Where it may come to rest ----------------------------------------------

/// The eight resting places: four corners, four edge centres.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
}

pub const ANCHORS: [Anchor; 8] = [
    Anchor::TopLeft,
    Anchor::Top,
    Anchor::TopRight,
    Anchor::Right,
    Anchor::BottomRight,
    Anchor::Bottom,
    Anchor::BottomLeft,
    Anchor::Left,
];

/// Where in the work area an anchor sits, as a fraction per axis.
fn fractions(anchor: Anchor) -> (f64, f64) {
    match anchor {
        Anchor::TopLeft => (0.0, 0.0),
        Anchor::Top => (0.5, 0.0),
        Anchor::TopRight => (1.0, 0.0),
        Anchor::Right => (1.0, 0.5),
        Anchor::BottomRight => (1.0, 1.0),
        Anchor::Bottom => (0.5, 1.0),
        Anchor::BottomLeft => (0.0, 1.0),
        Anchor::Left => (0.0, 0.5),
    }
}

impl Anchor {
    /// Does this anchor hang on the bottom edge? Then the pill belongs at
    /// the bottom of the window and the panel opens upwards — otherwise
    /// folding out would walk the pill away from under the pointer.
    ///
    /// Nothing in Rust calls this: which way the panel opens is a CSS
    /// decision, and the page derives it from the anchor's name. The rule
    /// lives here anyway, with a test on it, so that the two cannot quietly
    /// come apart — the anchor names are this module's, not the page's.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn at_bottom(self) -> bool {
        matches!(
            self,
            Anchor::BottomLeft | Anchor::Bottom | Anchor::BottomRight
        )
    }
}

/// A rectangle in points — screen work area or window.
///
/// Points, not pixels, and that is the whole trick of this module on macOS.
/// A "physical pixel" is not one coordinate system here but one per screen:
/// tao reports a monitor's position as its CGDisplayBounds multiplied by
/// *that monitor's* backing scale, and a window's position multiplied by the
/// scale of the screen the *window* is on. Put a 2x laptop display next to a
/// 1x monitor and those two numbers stop being comparable — which is how a
/// widget dropped on the second screen used to land on the first.
///
/// Points are what CGDisplayBounds counts in, what `monitor_from_point`
/// expects, and what `set_position(Logical)` writes. One space, no scales.
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn centre(self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

/// Where the window's top-left corner goes for this anchor.
///
/// The margin is kept on the edges the window touches; an edge it is centred
/// on gets none, otherwise "centre" would be off by half a margin.
pub fn place(anchor: Anchor, area: Rect, size: (f64, f64), margin: f64) -> (f64, f64) {
    let (fx, fy) = fractions(anchor);
    let free_x = area.w - size.0;
    let free_y = area.h - size.1;

    let offset = |fraction: f64, free: f64| -> f64 {
        match fraction {
            f if f <= 0.0 => margin,
            f if f >= 1.0 => free - margin,
            _ => free / 2.0,
        }
    };

    // A widget wider than the screen would otherwise be pushed off to the
    // left by the margin.
    let x = area.x + offset(fx, free_x).clamp(0.0, free_x.max(0.0));
    let y = area.y + offset(fy, free_y).clamp(0.0, free_y.max(0.0));
    (x, y)
}

/// The anchor closest to where the window was let go.
///
/// Measured centre to centre: dragging the pill into the lower right corner
/// should not land it at the bottom edge just because its top-left corner is
/// nearer to that.
pub fn nearest(window: Rect, area: Rect, margin: f64) -> Anchor {
    let (wx, wy) = window.centre();

    let mut best = Anchor::BottomRight;
    let mut best_distance = f64::MAX;
    for anchor in ANCHORS {
        let (px, py) = place(anchor, area, (window.w, window.h), margin);
        let (ax, ay) = Rect {
            x: px,
            y: py,
            w: window.w,
            h: window.h,
        }
        .centre();
        let distance = (ax - wx).powi(2) + (ay - wy).powi(2);
        if distance < best_distance {
            best_distance = distance;
            best = anchor;
        }
    }
    best
}

/// One screen, as this module needs it: where it is, how big its usable part
/// is, and what it is called — the name is what survives a restart.
#[derive(Clone, Debug)]
pub struct Screen {
    pub name: Option<String>,
    pub area: Rect,
}

/// Which screen a window belongs to, by its centre.
///
/// Its centre and not its corner: while being dragged across the boundary a
/// window hangs over both, and the one it is mostly on is the one the person
/// dragging it means. `remembered` wins when it is still attached, so a
/// widget that lived on the second screen comes back to the second screen.
pub fn screen_for(screens: &[Screen], window: Rect, remembered: Option<&str>) -> Option<Screen> {
    if let Some(name) = remembered {
        if let Some(found) = screens.iter().find(|s| s.name.as_deref() == Some(name)) {
            return Some(found.clone());
        }
    }
    let (cx, cy) = window.centre();
    screens
        .iter()
        .find(|s| s.area.contains(cx, cy))
        // No screen contains the centre: the window sits in a gap between two
        // displays, or the one it was on has just been unplugged.
        .or_else(|| screens.first())
        .cloned()
}

// --- What is remembered ------------------------------------------------------

/// Survives a restart: which screen the widget sat on, where on it, whether
/// it was unfolded, and whether it was on at all.
#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    pub anchor: Anchor,
    pub expanded: bool,
    pub visible: bool,
    /// The name of the screen it was last dropped on. Without this the widget
    /// comes back on whichever screen the window manager feels like, and a
    /// widget that has to be dragged back to the second monitor after every
    /// restart is one that gets switched off instead.
    ///
    /// A name and not an index: unplug a monitor and the indices shift, but a
    /// name that is gone is simply gone, and then the first screen takes over.
    #[serde(default)]
    pub screen: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        // Bottom right: the corner with the least on it on most screens.
        Self {
            anchor: Anchor::BottomRight,
            expanded: false,
            visible: false,
            screen: None,
        }
    }
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join("data/tracker.json")
}

pub fn load_state(dir: &Path) -> State {
    fs::read_to_string(state_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_state(dir: &Path, state: &State) {
    let path = state_path(dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, text);
    }
}

// --- The window --------------------------------------------------------------

/// Logical size of the pill and of the unfolded panel. Close in width on
/// purpose: folding out should grow the thing, not replace it.
const COLLAPSED: (f64, f64) = (208.0, 42.0);
const EXPANDED: (f64, f64) = (284.0, 390.0);
/// Distance from the screen edge, in points.
const MARGIN: f64 = 16.0;

fn size_for(expanded: bool) -> (f64, f64) {
    if expanded {
        EXPANDED
    } else {
        COLLAPSED
    }
}

/// Build the widget, or bring the one that exists back.
///
/// Showing one that exists reapplies size and anchor first. A window that
/// was left on a screen which has since been unplugged is still a window:
/// `show()` succeeds, nothing appears, and the widget looks broken. Snapping
/// it to a screen that exists right now is what makes "show" mean it.
pub fn open(app: &AppHandle, dir: &Path) -> tauri::Result<WebviewWindow> {
    let state = load_state(dir);
    if let Some(window) = app.get_webview_window("tracker") {
        // Only a window that is actually gone gets put back on its anchor.
        // Re-placing one that is already up is what made the widget jump:
        // the guard thread calls in here every few seconds, and during a
        // drag — or a move to another screen, where macOS reports the window
        // as hidden for a moment — that snapped it out from under the
        // pointer.
        if !window.is_visible().unwrap_or(false) {
            apply(&window, &state);
        }
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        return Ok(window);
    }

    let (w, h) = size_for(state.expanded);
    let window = WebviewWindowBuilder::new(app, "tracker", WebviewUrl::App("tracker.html".into()))
        .title("Zeit")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        // Out of the window menu and out of the app switcher: a widget is
        // not a window anybody wants to Cmd+Tab to.
        .skip_taskbar(true)
        // Follows to the next space instead of staying behind on the one it
        // was opened on — which looks exactly like having disappeared.
        .visible_on_all_workspaces(true)
        // Without this the first click only brings the widget forward and
        // the button under the pointer does nothing.
        .accept_first_mouse(true)
        .visible(false)
        .build()?;

    apply(&window, &state);
    // Every screen once, when the widget is built. On a desk where the widget
    // ends up on the wrong one, this is the first thing worth knowing — and
    // it names the screens the way `data/tracker.json` remembers them.
    for screen in screens(&window) {
        eprintln!("[widget] Bildschirm {}", describe(&screen));
    }
    if let Some(screen) = screen_of(&window, state.screen.as_deref()) {
        eprintln!("[widget] offen auf {}", describe(&screen));
    }
    let _ = window.show();
    Ok(window)
}

/// Resize to the current shape and put it back on its anchor.
///
/// Both at once, deliberately: unfolding a pill that sits at the bottom edge
/// has to grow upwards, and that is a move, not a resize.
pub fn apply(window: &WebviewWindow, state: &State) {
    // Once before the resize, so a widget on the bottom edge does not reach
    // past the screen for a frame, and once after, because the resize moves
    // the window on its own — on macOS it keeps the bottom edge and grows
    // upwards.
    snap_to(window, state);
    let (w, h) = size_for(state.expanded);
    let _ = window.set_size(LogicalSize::new(w, h));
    snap_to(window, state);
}

/// Move the window onto its anchor, on the screen it belongs to.
///
/// The shape comes from `expanded`, never from `outer_size()`: a resize lands
/// a frame later than the call asking for it, so right after unfolding the
/// window still reports the pill's 42 points. Anchoring the 390-point panel
/// by that number is what hung it off the bottom of the screen.
pub fn snap_to(window: &WebviewWindow, state: &State) {
    let (w, h) = size_for(state.expanded);
    let Some(screen) = screen_of(window, state.screen.as_deref()) else {
        eprintln!("[widget] kein Bildschirm gefunden — Fenster bleibt, wo es ist");
        return;
    };
    let (x, y) = place(state.anchor, screen.area, (w, h), MARGIN);
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// Put the widget's top-left corner at this spot, in points.
///
/// The widget drags itself rather than letting the window manager do it: a
/// native drag ends wherever the mouse was released, and this one has to end
/// on a resting place. The page sends where the window belongs, not how far
/// it should move — a position cannot drift, a sum of deltas can, and a lost
/// event then costs a frame instead of the rest of the drag.
///
/// Logical and not physical: the page reads `event.screenX`, which is in
/// points, and points are the one coordinate system that stays the same
/// across screens of different scale.
pub fn place_at(window: &WebviewWindow, x: f64, y: f64) {
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// The resting place the widget was let go closest to, and the screen it
/// ended up on.
pub fn dropped_on(window: &WebviewWindow, expanded: bool) -> Option<(Anchor, Option<String>)> {
    let rect = window_rect(window, expanded)?;
    // No remembered name here: this is the moment the widget is being told
    // where it now lives, so only its real position counts.
    let screen = screen_of_rect(window, rect, None)?;
    let anchor = nearest(rect, screen.area, MARGIN);
    // The one decision that used to be wrong, and on a desk with two screens
    // of different scale the only way to see which screen the widget thinks
    // it is on without watching it move.
    eprintln!(
        "[widget] losgelassen auf {} -> {anchor:?}",
        describe(&screen)
    );
    Some((anchor, screen.name))
}

/// A screen in one line, for the log. Points throughout, so the numbers can
/// be compared with each other — which is the whole point of this module.
fn describe(screen: &Screen) -> String {
    format!(
        "{} ({}x{} ab {},{})",
        screen.name.as_deref().unwrap_or("unbenannt"),
        screen.area.w,
        screen.area.h,
        screen.area.x,
        screen.area.y
    )
}

/// Where the window is, in points.
///
/// The size is taken from `expanded` for the same reason `snap_to` does it:
/// `outer_size()` can still be the shape before the last resize. The
/// position has to be read, though, and `outer_position()` is physical in the
/// scale of the window's current screen — so it is divided by exactly that.
fn window_rect(window: &WebviewWindow, expanded: bool) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    let (w, h) = size_for(expanded);
    Some(Rect {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        w,
        h,
    })
}

/// Every screen that is attached right now, in points.
fn screens(window: &WebviewWindow) -> Vec<Screen> {
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            Screen {
                name: monitor.name().cloned(),
                // The work area rather than the full screen, so "bottom
                // right" is not behind the Dock. Both come back in the
                // monitor's own scale and are divided by it.
                area: Rect {
                    x: area.position.x as f64 / scale,
                    y: area.position.y as f64 / scale,
                    w: area.size.width as f64 / scale,
                    h: area.size.height as f64 / scale,
                },
            }
        })
        .collect()
}

/// The screen the window belongs to.
fn screen_of(window: &WebviewWindow, remembered: Option<&str>) -> Option<Screen> {
    let rect = window_rect(window, false)?;
    screen_of_rect(window, rect, remembered)
}

fn screen_of_rect(window: &WebviewWindow, rect: Rect, remembered: Option<&str>) -> Option<Screen> {
    let attached = screens(window);
    if attached.is_empty() {
        return None;
    }
    screen_for(&attached, rect, remembered)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1600x1000 work area starting at the origin, as a single screen.
    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1600.0,
        h: 1000.0,
    };
    const PILL: (f64, f64) = (200.0, 50.0);
    const MARGIN: f64 = 16.0;

    fn screen(name: &str, x: f64, y: f64, w: f64, h: f64) -> Screen {
        Screen {
            name: Some(name.to_string()),
            area: Rect { x, y, w, h },
        }
    }

    #[test]
    fn corners_keep_their_margin_and_centres_do_not() {
        assert_eq!(place(Anchor::TopLeft, AREA, PILL, MARGIN), (16.0, 16.0));
        assert_eq!(
            place(Anchor::BottomRight, AREA, PILL, MARGIN),
            (1384.0, 934.0)
        );
        // 1600 - 200 = 1400 free, half of it is the centre.
        assert_eq!(place(Anchor::Top, AREA, PILL, MARGIN), (700.0, 16.0));
        assert_eq!(place(Anchor::Left, AREA, PILL, MARGIN), (16.0, 475.0));
    }

    #[test]
    fn a_second_screen_is_offset_not_assumed_at_zero() {
        let right = Rect {
            x: 1600.0,
            y: -200.0,
            w: 1600.0,
            h: 1000.0,
        };
        assert_eq!(
            place(Anchor::TopLeft, right, PILL, MARGIN),
            (1616.0, -184.0)
        );
        assert_eq!(
            place(Anchor::BottomRight, right, PILL, MARGIN),
            (2984.0, 734.0)
        );
    }

    #[test]
    fn a_widget_wider_than_the_screen_still_lands_on_it() {
        let narrow = Rect {
            x: 0.0,
            y: 0.0,
            w: 120.0,
            h: 60.0,
        };
        assert_eq!(place(Anchor::BottomRight, narrow, PILL, MARGIN), (0.0, 0.0));
    }

    #[test]
    fn letting_go_picks_the_nearest_resting_place() {
        let dropped = |x: f64, y: f64| {
            nearest(
                Rect {
                    x,
                    y,
                    w: PILL.0,
                    h: PILL.1,
                },
                AREA,
                MARGIN,
            )
        };
        assert_eq!(dropped(40.0, 30.0), Anchor::TopLeft);
        assert_eq!(dropped(1300.0, 900.0), Anchor::BottomRight);
        assert_eq!(dropped(700.0, 20.0), Anchor::Top);
        assert_eq!(dropped(1380.0, 480.0), Anchor::Right);
        // Dead centre of the screen is no resting place. The nearest edge
        // wins, and on a screen wider than it is tall that is the top one.
        assert_eq!(dropped(700.0, 475.0), Anchor::Top);
    }

    #[test]
    fn the_bottom_anchors_know_they_are_at_the_bottom() {
        for anchor in [Anchor::BottomLeft, Anchor::Bottom, Anchor::BottomRight] {
            assert!(anchor.at_bottom(), "{anchor:?}");
        }
        for anchor in [
            Anchor::TopLeft,
            Anchor::Top,
            Anchor::TopRight,
            Anchor::Left,
            Anchor::Right,
        ] {
            assert!(!anchor.at_bottom(), "{anchor:?}");
        }
    }

    #[test]
    fn folding_out_at_the_bottom_keeps_the_bottom_edge() {
        let pill = place(Anchor::BottomRight, AREA, (208.0, 42.0), MARGIN);
        let panel = place(Anchor::BottomRight, AREA, (284.0, 390.0), MARGIN);
        // Same bottom edge, same right edge: it grows up and to the left.
        assert_eq!(pill.1 + 42.0, panel.1 + 390.0);
        assert_eq!(pill.0 + 208.0, panel.0 + 284.0);
    }

    #[test]
    fn the_unfolded_panel_stays_on_screen_from_every_resting_place() {
        // What went wrong was not the arithmetic but the size handed to it:
        // the panel was anchored by the pill's height and hung off the
        // bottom. Both shapes, every anchor, inside the work area.
        for expanded in [false, true] {
            let size = size_for(expanded);
            for anchor in ANCHORS {
                let (x, y) = place(anchor, AREA, size, MARGIN);
                assert!(x >= AREA.x, "{anchor:?} links raus");
                assert!(y >= AREA.y, "{anchor:?} oben raus");
                assert!(x + size.0 <= AREA.x + AREA.w, "{anchor:?} rechts raus");
                assert!(y + size.1 <= AREA.y + AREA.h, "{anchor:?} unten raus");
            }
        }
    }

    // --- Which screen it belongs to ------------------------------------------
    //
    // These are the ones that used to be wrong. A laptop display at 2x next
    // to an external monitor at 1x: in points the two sit side by side, and
    // nothing in here may care about their scales any more.

    /// 1512x945 points of laptop display, 1920x1080 points of monitor to the
    /// right of it — the mixed-scale case, expressed the only way that works.
    fn two_screens() -> Vec<Screen> {
        vec![
            screen("Built-in Retina Display", 0.0, 0.0, 1512.0, 945.0),
            screen("DELL U2720Q", 1512.0, 0.0, 1920.0, 1080.0),
        ]
    }

    #[test]
    fn a_widget_dropped_on_the_second_screen_belongs_to_the_second_screen() {
        let on_the_right = Rect {
            x: 2400.0,
            y: 800.0,
            w: 208.0,
            h: 42.0,
        };
        let found = screen_for(&two_screens(), on_the_right, None).unwrap();
        assert_eq!(found.name.as_deref(), Some("DELL U2720Q"));

        // And it rests in that screen's bottom right, not the laptop's.
        let (x, y) = place(Anchor::BottomRight, found.area, (208.0, 42.0), MARGIN);
        assert_eq!(
            (x, y),
            (1512.0 + 1920.0 - 208.0 - 16.0, 1080.0 - 42.0 - 16.0)
        );
    }

    #[test]
    fn a_widget_over_the_boundary_belongs_where_its_centre_is() {
        // Left edge still on the laptop, centre already on the monitor.
        let crossing = Rect {
            x: 1450.0,
            y: 400.0,
            w: 208.0,
            h: 42.0,
        };
        assert_eq!(
            screen_for(&two_screens(), crossing, None)
                .unwrap()
                .name
                .as_deref(),
            Some("DELL U2720Q")
        );

        // And the other way round: mostly still on the laptop.
        let barely = Rect {
            x: 1380.0,
            y: 400.0,
            w: 208.0,
            h: 42.0,
        };
        assert_eq!(
            screen_for(&two_screens(), barely, None)
                .unwrap()
                .name
                .as_deref(),
            Some("Built-in Retina Display")
        );
    }

    #[test]
    fn a_remembered_screen_wins_while_it_is_attached() {
        // The window is reported on the laptop — after a restart it always
        // is — but it was last dropped on the monitor, so that is where it
        // goes back to.
        let on_the_laptop = Rect {
            x: 100.0,
            y: 100.0,
            w: 208.0,
            h: 42.0,
        };
        let found = screen_for(&two_screens(), on_the_laptop, Some("DELL U2720Q")).unwrap();
        assert_eq!(found.name.as_deref(), Some("DELL U2720Q"));
    }

    #[test]
    fn a_remembered_screen_that_is_gone_falls_back_to_the_first() {
        let laptop_only = vec![screen("Built-in Retina Display", 0.0, 0.0, 1512.0, 945.0)];
        let anywhere = Rect {
            x: 100.0,
            y: 100.0,
            w: 208.0,
            h: 42.0,
        };
        let found = screen_for(&laptop_only, anywhere, Some("DELL U2720Q")).unwrap();
        assert_eq!(found.name.as_deref(), Some("Built-in Retina Display"));
    }

    #[test]
    fn a_widget_in_the_gap_between_two_screens_still_lands_somewhere() {
        // Screens that do not touch: a centre in the gap belongs to no
        // screen, and "no screen" may not mean "no position".
        let apart = vec![
            screen("left", 0.0, 0.0, 1000.0, 800.0),
            screen("right", 2000.0, 0.0, 1000.0, 800.0),
        ];
        let in_the_gap = Rect {
            x: 1500.0,
            y: 400.0,
            w: 208.0,
            h: 42.0,
        };
        assert!(screen_for(&apart, in_the_gap, None).is_some());
    }

    #[test]
    fn without_a_screen_there_is_nothing_to_snap_to() {
        let nothing: Vec<Screen> = Vec::new();
        let anywhere = Rect {
            x: 0.0,
            y: 0.0,
            w: 208.0,
            h: 42.0,
        };
        assert!(screen_for(&nothing, anywhere, None).is_none());
        assert!(screen_for(&nothing, anywhere, Some("DELL U2720Q")).is_none());
    }

    // --- What is remembered --------------------------------------------------

    #[test]
    fn the_remembered_state_survives_a_round_trip() {
        let state = State {
            anchor: Anchor::Left,
            expanded: true,
            visible: true,
            screen: Some("DELL U2720Q".to_string()),
        };
        let text = serde_json::to_string(&state).unwrap();
        assert!(text.contains("\"left\""));
        let back: State = serde_json::from_str(&text).unwrap();
        assert_eq!(back.anchor, Anchor::Left);
        assert!(back.expanded && back.visible);
        assert_eq!(back.screen.as_deref(), Some("DELL U2720Q"));
    }

    #[test]
    fn a_state_file_from_before_the_screen_was_remembered_still_reads() {
        // Written by an older build. A missing field may not cost the anchor.
        let old = r#"{"anchor":"bottom","expanded":false,"visible":true}"#;
        let back: State = serde_json::from_str(old).unwrap();
        assert_eq!(back.anchor, Anchor::Bottom);
        assert!(back.visible);
        assert!(back.screen.is_none());
    }

    #[test]
    fn an_unreadable_state_file_is_the_bottom_right_corner() {
        let state = State::default();
        assert_eq!(state.anchor, Anchor::BottomRight);
        assert!(!state.expanded && !state.visible);
        assert!(state.screen.is_none());
    }
}
