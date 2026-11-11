// @polsia:user-owned
import SwiftUI

@main
struct SolcoApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .tint(SolcoPalette.lime)
        }
    }
}

enum SolcoPalette {
    static let background = Color(solcoHex: 0x08151F)
    static let surface = Color(solcoHex: 0x10232F)
    static let elevated = Color(solcoHex: 0x142A37)
    static let foreground = Color(solcoHex: 0xEDF5F6)
    static let muted = Color(solcoHex: 0xB1C5CD)
    static let lime = Color(solcoHex: 0xC5ED72)
    static let aqua = Color(solcoHex: 0x6BD4CA)
    static let border = Color(solcoHex: 0x2C4652)
    static let ink = Color(solcoHex: 0x19261B)
}

extension Color {
    init(solcoHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
