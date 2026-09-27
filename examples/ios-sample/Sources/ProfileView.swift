import SwiftUI

/// The SwiftUI screen: no UIView per control, so the collector reads the hosting view's
/// accessibility elements instead of subviews.
struct ProfileView: View {
  @State private var name = "Ada"
  @State private var dark = false

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Profile").font(.title.bold()).accessibilityAddTraits(.isHeader)
      TextField("Name", text: $name)
        .textFieldStyle(.roundedBorder)
      Toggle("Dark mode", isOn: $dark)
      HStack(spacing: 12) {
        HStack(spacing: 0) {
          Button("Save") {}
            .buttonStyle(.borderedProminent)
            .tint(Color(UIColor.brandBlue))
          // Planted: a 20x20 target touching "Save", so its spacing circle runs into it.
          Button("Tiny") {}
            .font(.system(size: 10))
            .frame(width: 20, height: 20)
            .background(Color(UIColor.brandBlue))
            .foregroundColor(.white)
        }
        // Planted: image-only button with no label (a drawn image; an SF Symbol names itself).
        Button(action: {}) { Image(uiImage: drawnGlyph()) }
          .frame(width: 44, height: 44)
      }
      Spacer()
    }
    .padding()
    .navigationTitle("Profile")
  }
}
