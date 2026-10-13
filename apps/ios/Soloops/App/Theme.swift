import SwiftUI

/// The design system, as far as a phone can carry it.
///
/// The same values as `apps/web/src/style.css`, because the two halves of
/// soloops should not look like two products. Paper rather than screen: a warm
/// off-white, near-black ink, hairlines instead of boxes, square corners, and
/// pills for anything you press.
///
/// Deliberately not everything. The web interface layers three surfaces to
/// give a dense tool some depth; a phone screen shows one thing at a time and
/// gets muddy if you try. Shell is unused here, and the raised surface only
/// appears where something genuinely lies on top.
enum Paper {
    static let shell = Color(hex: 0xDB_D7_CA)
    static let paper = Color(hex: 0xF1_EF_E8)
    static let raised = Color(hex: 0xFB_FA_F7)
    static let paper2 = Color(hex: 0xE9_E7_DF)

    static let ink = Color(hex: 0x17_17_14)
    static let soft = Color(hex: 0x57_57_50)
    static let muted = Color(hex: 0x6C_6B_64)

    static let acid = Color(hex: 0xD8_FF_55)
    static let blue = Color(hex: 0x5C_76_FF)

    static let good = Color(hex: 0x1F_7A_3D)
    static let warn = Color(hex: 0xA3_5C_00)
    static let bad = Color(hex: 0xB3_26_1E)

    static let line = Color(hex: 0x17_17_14, opacity: 0.15)
    static let lineStrong = Color(hex: 0x17_17_14, opacity: 0.30)
}

/// Space Grotesk for headings, numbers and anything tabular; the system face
/// for body copy — the same split the web interface makes.
enum Display {
    static func font(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom(weight.postScriptName, size: size)
    }

    enum Weight {
        case regular, medium, bold

        var postScriptName: String {
            switch self {
            case .regular: return "SpaceGrotesk-Regular"
            case .medium: return "SpaceGrotesk-Medium"
            case .bold: return "SpaceGrotesk-Bold"
            }
        }
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// --- The pieces that repeat ------------------------------------------------

/// A section label: small, letterspaced, upper case, blue. Sections in soloops
/// do not carry a heading at body size — they carry one of these.
struct Eyebrow: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(Display.font(11, .medium))
            .tracking(1.2)
            .foregroundStyle(Paper.blue)
    }
}

/// A hairline. Structure in soloops comes from lines, not from boxes.
struct Rule: View {
    var strong = false

    var body: some View {
        Rectangle()
            .fill(strong ? Paper.lineStrong : Paper.line)
            .frame(height: strong ? 2 : 1)
    }
}

/// The only button shape there is.
struct PillButton: ButtonStyle {
    enum Kind { case primary, ghost, acid }
    var kind: Kind = .primary

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Display.font(16, .medium))
            .padding(.horizontal, 22)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(Capsule())
            .overlay(
                Capsule().stroke(kind == .ghost ? Paper.lineStrong : .clear, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
    }

    private var background: Color {
        switch kind {
        case .primary: return Paper.ink
        case .ghost: return .clear
        case .acid: return Paper.acid
        }
    }

    private var foreground: Color {
        switch kind {
        case .primary: return Paper.paper
        case .ghost, .acid: return Paper.ink
        }
    }
}

/// A row that sits under a heavy rule and carries a figure, the way key
/// numbers are set on the web.
struct StatRow: View {
    let label: String
    let value: String
    var hint: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Rule(strong: true)
            Text(label)
                .font(.footnote)
                .foregroundStyle(Paper.muted)
                .padding(.top, 8)
            Text(value)
                .font(Display.font(28, .bold))
                .monospacedDigit()
            if let hint {
                Text(hint).font(.caption).foregroundStyle(Paper.muted)
            }
        }
    }
}
