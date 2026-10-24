//
//  ClickItOrbMenu.swift
//  leanring-buddy
//
//  Click It: a floating five-gemstone radial menu.
//
//  The menu lives in its own small interactive panel, separate from the
//  blue-cursor OverlayWindow. That overlay is click-through and tied to the
//  push-to-talk voice flow, so hosting clickable gemstones inside it would
//  change existing behavior. A separate panel keeps push-to-talk untouched.
//

import AppKit
import SwiftUI

// MARK: - Click It Actions

/// The five Click It actions, each shown as a gemstone in the radial menu.
enum ClickItAction: String, CaseIterable, Identifiable {
    case snap
    case askExplain
    case translate
    case speech
    case privacyGuard

    var id: String { rawValue }

    /// Short label shown under each gemstone.
    var label: String {
        switch self {
        case .snap: return "Snap"
        case .askExplain: return "Ask / Explain"
        case .translate: return "Translate"
        case .speech: return "Speech"
        case .privacyGuard: return "Privacy Guard"
        }
    }

    /// Tooltip and accessibility hint for each gemstone.
    var tooltip: String {
        switch self {
        case .snap: return "Capture your screen and get a summary and explanation"
        case .askExplain: return "Ask a question about your screen or selected text"
        case .translate: return "Translate selected text or screen content"
        case .speech: return "Speech-to-text (coming soon)"
        case .privacyGuard: return "Check content for sensitive information before sharing"
        }
    }

    /// SF Symbol drawn inside each gemstone.
    var symbolName: String {
        switch self {
        case .snap: return "camera.viewfinder"
        case .askExplain: return "questionmark.bubble"
        case .translate: return "character.bubble"
        case .speech: return "waveform"
        case .privacyGuard: return "lock.shield"
        }
    }

    /// Gemstone color for each action.
    var gemstoneColor: Color {
        switch self {
        case .snap: return Color(red: 0.25, green: 0.52, blue: 0.96)
        case .askExplain: return Color(red: 0.36, green: 0.76, blue: 0.47)
        case .translate: return Color(red: 0.96, green: 0.62, blue: 0.22)
        case .speech: return Color(red: 0.64, green: 0.38, blue: 0.93)
        case .privacyGuard: return Color(red: 0.91, green: 0.31, blue: 0.38)
        }
    }

    /// Speech stays visible but disabled until speech-to-text is built.
    var isAvailable: Bool {
        self != .speech
    }
}

// MARK: - Radial Menu View

/// A center close orb surrounded by five gemstones. Each gemstone floats
/// gently, grows and glows on hover, and shows a ring when selected with the
/// keyboard. Arrow keys or Tab move the selection, Return or Space activates
/// it, and Escape closes the menu.
struct ClickItOrbMenuView: View {
    let onSelectAction: (ClickItAction) -> Void
    let onDismiss: () -> Void

    private let allActions: [ClickItAction] = ClickItAction.allCases
    private let menuRadius: CGFloat = 100
    private let gemstoneDiameter: CGFloat = 56

    @State private var hoveredAction: ClickItAction?
    @State private var keyboardSelectedActionIndex: Int = 0
    @State private var menuAppearScale: CGFloat = 0.6
    @State private var isFloatingUp: Bool = false
    @FocusState private var isMenuFocused: Bool

    var body: some View {
        ZStack {
            centerCloseOrb

            ForEach(Array(allActions.enumerated()), id: \.element) { actionIndex, action in
                gemstoneButton(for: action, actionIndex: actionIndex)
                    .offset(gemstoneOffset(forActionIndex: actionIndex))
            }
        }
        .frame(width: 340, height: 340)
        .scaleEffect(menuAppearScale)
        .focusable(true)
        .focusEffectDisabled()
        .focused($isMenuFocused)
        .onKeyPress { keyPress in
            handleKeyPress(keyPress)
        }
        .onAppear {
            isMenuFocused = true
            withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                menuAppearScale = 1.0
            }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                isFloatingUp = true
            }
        }
    }

    // MARK: Center Close Orb

    private var centerCloseOrb: some View {
        Button(action: onDismiss) {
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Color.white.opacity(0.95), DS.Colors.overlayCursorBlue],
                            center: .center,
                            startRadius: 2,
                            endRadius: 26
                        )
                    )
                    .frame(width: 46, height: 46)
                    .shadow(color: DS.Colors.overlayCursorBlue.opacity(0.6), radius: 12)
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(DS.Colors.overlayCursorBlue)
            }
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .offset(y: isFloatingUp ? -2 : 2)
        .help("Close Click It (Esc)")
        .accessibilityLabel("Close Click It menu")
    }

    // MARK: Gemstone Button

    private func gemstoneButton(for action: ClickItAction, actionIndex: Int) -> some View {
        let isHovered = hoveredAction == action
        let isKeyboardSelected = keyboardSelectedActionIndex == actionIndex
        let isHighlighted = (isHovered || isKeyboardSelected) && action.isAvailable

        return VStack(spacing: 5) {
            Button {
                onSelectAction(action)
            } label: {
                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                colors: [Color.white.opacity(0.6), action.gemstoneColor, action.gemstoneColor.opacity(0.7)],
                                center: UnitPoint(x: 0.3, y: 0.25),
                                startRadius: 1,
                                endRadius: gemstoneDiameter
                            )
                        )
                        .overlay(
                            Circle().stroke(
                                Color.white.opacity(isKeyboardSelected ? 0.95 : (isHovered ? 0.75 : 0.3)),
                                lineWidth: isKeyboardSelected ? 3 : (isHovered ? 2 : 1)
                            )
                        )
                        .shadow(color: action.gemstoneColor.opacity(isHighlighted ? 0.95 : 0.45), radius: isHighlighted ? 18 : 7)
                    Image(systemName: action.symbolName)
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundColor(.white)
                }
                .frame(width: gemstoneDiameter, height: gemstoneDiameter)
                .scaleEffect(isHighlighted ? 1.16 : 1.0)
            }
            .buttonStyle(.plain)
            .disabled(!action.isAvailable)
            .pointerCursor(isEnabled: action.isAvailable)

            Text(action.isAvailable ? action.label : "\(action.label) - Coming soon")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.black.opacity(isHighlighted ? 0.85 : 0.6)))
                .fixedSize()
        }
        // Disabled gemstones stay visible but dimmed.
        .opacity(action.isAvailable ? 1.0 : 0.45)
        // Neighboring gemstones float in opposite directions for a hover effect.
        .offset(y: isFloatingUp ? (actionIndex % 2 == 0 ? -3 : 3) : (actionIndex % 2 == 0 ? 3 : -3))
        .animation(.spring(response: 0.3, dampingFraction: 0.65), value: isHighlighted)
        .onHover { isHovering in
            if isHovering {
                hoveredAction = action
            } else if hoveredAction == action {
                hoveredAction = nil
            }
        }
        .help(action.tooltip)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(action.isAvailable ? action.label : "\(action.label), coming soon")
        .accessibilityHint(action.tooltip)
    }

    // MARK: Layout

    /// Spreads the gemstones evenly around the center, starting at the top.
    private func gemstoneOffset(forActionIndex actionIndex: Int) -> CGSize {
        let angleInRadians = (Double(actionIndex) / Double(allActions.count)) * 2 * Double.pi - Double.pi / 2
        return CGSize(
            width: cos(angleInRadians) * menuRadius,
            height: sin(angleInRadians) * menuRadius
        )
    }

    // MARK: Keyboard

    private func handleKeyPress(_ keyPress: KeyPress) -> KeyPress.Result {
        switch keyPress.key {
        case .escape:
            onDismiss()
            return .handled
        case .return, .space:
            let selectedAction = allActions[keyboardSelectedActionIndex]
            guard selectedAction.isAvailable else { return .handled }
            onSelectAction(selectedAction)
            return .handled
        case .rightArrow, .downArrow, .tab:
            keyboardSelectedActionIndex = (keyboardSelectedActionIndex + 1) % allActions.count
            return .handled
        case .leftArrow, .upArrow:
            keyboardSelectedActionIndex = (keyboardSelectedActionIndex - 1 + allActions.count) % allActions.count
            return .handled
        default:
            return .ignored
        }
    }
}

// MARK: - Interactive Panel

/// Borderless panels refuse key status by default, which would block the
/// keyboard controls in the menu. This subclass opts in so arrow keys,
/// Return, and Escape work, while still never activating the app.
final class ClickItKeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Owns the floating panel that hosts the gemstone menu. The panel appears
/// centered on the mouse cursor and closes when the user picks an action,
/// presses Escape, clicks the center orb, or clicks anywhere else.
@MainActor
final class ClickItOrbMenuPanelManager {
    private var orbMenuPanel: ClickItKeyablePanel?
    private var panelResignKeyObserver: NSObjectProtocol?
    private let orbMenuPanelSize = NSSize(width: 340, height: 340)

    var isShowingOrbMenu: Bool { orbMenuPanel != nil }

    func showOrbMenu(
        onSelectAction: @escaping (ClickItAction) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        hideOrbMenu()

        let orbMenuView = ClickItOrbMenuView(
            onSelectAction: onSelectAction,
            onDismiss: onDismiss
        )
        let orbMenuHostingView = NSHostingView(rootView: orbMenuView)

        let mouseLocation = NSEvent.mouseLocation
        let panelOrigin = NSPoint(
            x: mouseLocation.x - orbMenuPanelSize.width / 2,
            y: mouseLocation.y - orbMenuPanelSize.height / 2
        )

        let newOrbMenuPanel = ClickItKeyablePanel(
            contentRect: NSRect(origin: panelOrigin, size: orbMenuPanelSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        newOrbMenuPanel.isOpaque = false
        newOrbMenuPanel.backgroundColor = .clear
        newOrbMenuPanel.hasShadow = false
        newOrbMenuPanel.level = .popUpMenu
        newOrbMenuPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        newOrbMenuPanel.isReleasedWhenClosed = false
        newOrbMenuPanel.hidesOnDeactivate = false
        newOrbMenuPanel.contentView = orbMenuHostingView

        // Keep the whole menu on screen when the cursor is near an edge.
        let screenUnderCursor = NSScreen.screens.first { $0.frame.contains(mouseLocation) } ?? NSScreen.main
        if let visibleScreenFrame = screenUnderCursor?.visibleFrame {
            var clampedPanelFrame = newOrbMenuPanel.frame
            clampedPanelFrame.origin.x = min(max(clampedPanelFrame.origin.x, visibleScreenFrame.minX), visibleScreenFrame.maxX - orbMenuPanelSize.width)
            clampedPanelFrame.origin.y = min(max(clampedPanelFrame.origin.y, visibleScreenFrame.minY), visibleScreenFrame.maxY - orbMenuPanelSize.height)
            newOrbMenuPanel.setFrame(clampedPanelFrame, display: true)
        }

        newOrbMenuPanel.makeKeyAndOrderFront(nil)
        orbMenuPanel = newOrbMenuPanel

        // Clicking outside the menu takes key status away from the panel,
        // which we treat as a dismiss so the menu never lingers.
        panelResignKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: newOrbMenuPanel,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                onDismiss()
            }
        }
    }

    func hideOrbMenu() {
        if let panelResignKeyObserver {
            NotificationCenter.default.removeObserver(panelResignKeyObserver)
            self.panelResignKeyObserver = nil
        }
        orbMenuPanel?.orderOut(nil)
        orbMenuPanel?.contentView = nil
        orbMenuPanel = nil
    }
}
