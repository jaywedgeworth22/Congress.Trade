import SwiftUI

/// Full-screen brand splash: eagle flies into view, then settles where the
/// header `BrandLogo` lives (top-leading, ~28pt). Mirrors the website motion.
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

    var body: some View {
        GeometryReader { geo in
            let brandSize: CGFloat = 28
            let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            // Approximate final brand mark: top bar padding + leading inset.
            let settled = CGPoint(
                x: 16 + brandSize / 2,
                y: geo.safeAreaInsets.top + 14 + brandSize / 2
            )
            let showLarge = phase == .enter
            let showSettled = phase == .settle || phase == .done
            let size: CGFloat = showSettled ? brandSize : (showLarge ? 120 : 64)
            let position = showSettled ? settled : center
            let opacity: Double = phase == .hidden || phase == .done ? 0 : 1
            let bgOpacity: Double = (phase == .settle || phase == .done) ? 0 : (phase == .hidden ? 0 : 1)

            ZStack {
                Color(red: 0.04, green: 0.06, blue: 0.12)
                    .opacity(bgOpacity)
                    .ignoresSafeArea()

                Image("BrandLogo")
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: showSettled ? 7 : 28, style: .continuous))
                    .shadow(color: .black.opacity(showSettled ? 0.15 : 0.45), radius: showSettled ? 2 : 18, y: showSettled ? 1 : 10)
                    .rotationEffect(.degrees(phase == .enter ? 0 : (phase == .hidden ? -14 : 0)))
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
        // Enter: pop into center.
        withAnimation(.spring(response: 0.55, dampingFraction: 0.78)) {
            phase = .enter
        }
        // Fly to brand mark, then dismiss overlay.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) {
            withAnimation(.timingCurve(0.22, 0.9, 0.28, 1.0, duration: 0.9)) {
                phase = .settle
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.95) {
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
