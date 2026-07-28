import SwiftUI

/// Full-screen brand splash: eagle flies in large (foreground), then recedes
/// into the header brand slot (smaller, as if flying away into the distance).
/// Mirrors the website motion in `dashboardHtml.ts`.
struct EagleSplashView: View {
    var onFinished: () -> Void

    @State private var phase: Phase = .hidden
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Phase {
        case hidden
        case enter
        case settle
        case done
    }

    /// Large "close to camera" size when the eagle first appears.
    private let flyInSize: CGFloat = 260
    /// Final header mark size (matches `BrandTitle` / website brand height).
    private let settledSize: CGFloat = 32

    var body: some View {
        GeometryReader { geo in
            let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            // Top-leading brand mark: padding + half of settled size.
            let settled = CGPoint(
                x: 16 + settledSize / 2,
                y: geo.safeAreaInsets.top + 12 + settledSize / 2
            )

            let size: CGFloat = {
                switch phase {
                case .hidden: return flyInSize * 0.4
                case .enter: return flyInSize
                case .settle, .done: return settledSize
                }
            }()
            let position: CGPoint = {
                switch phase {
                case .settle, .done: return settled
                default: return center
                }
            }()
            let rotation: Double = {
                switch phase {
                case .hidden: return -18
                case .enter: return 0
                case .settle, .done: return 0
                }
            }()
            let opacity: Double = (phase == .hidden || phase == .done) ? 0 : 1
            let bgOpacity: Double = {
                switch phase {
                case .hidden: return 0
                case .enter: return 1
                case .settle: return 0.55
                case .done: return 0
                }
            }()
            let shadowRadius: CGFloat = phase == .enter ? 28 : (phase == .settle ? 4 : 0)
            let shadowY: CGFloat = phase == .enter ? 16 : 2

            ZStack {
                Color(red: 0.031, green: 0.067, blue: 0.12)
                    .opacity(bgOpacity)
                    .ignoresSafeArea()

                Image("BrandLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .shadow(color: .black.opacity(phase == .enter ? 0.5 : 0.2), radius: shadowRadius, y: shadowY)
                    .rotationEffect(.degrees(rotation))
                    // Subtle "banking" while entering — feels airborne.
                    .rotation3DEffect(
                        .degrees(phase == .enter ? 8 : 0),
                        axis: (x: 0.2, y: 1, z: 0.15),
                        perspective: 0.55
                    )
                    .position(position)
                    .opacity(opacity)
            }
            .allowsHitTesting(false)
            .onAppear { runSequence() }
        }
    }

    private func runSequence() {
        if reduceMotion {
            phase = .done
            onFinished()
            return
        }

        // Enter: spring up large in center (close to viewer).
        withAnimation(.spring(response: 0.58, dampingFraction: 0.72)) {
            phase = .enter
        }

        // Fly away into the header slot: shrink + translate (recedes into distance).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            withAnimation(.timingCurve(0.22, 0.82, 0.28, 1.0, duration: 0.95)) {
                phase = .settle
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.3)) {
                    phase = .done
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
                    onFinished()
                }
            }
        }
    }
}
