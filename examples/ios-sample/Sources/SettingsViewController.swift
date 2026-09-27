import UIKit
import SwiftUI

/// A 44pt tappable row (an operable ancestor) with a 17pt button inside it.
final class RowControl: UIControl {
  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityLabel = "Row 1"
    accessibilityTraits = .button
    backgroundColor = UIColor(white: 0.95, alpha: 1)
    layer.cornerRadius = 8
  }
  required init?(coder: NSCoder) { fatalError() }
}

final class SettingsViewController: UIViewController {
  private let scrollView = UIScrollView()
  private let content = UIStackView()

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Settings"
    view.backgroundColor = .white
    navigationController?.navigationBar.prefersLargeTitles = false

    scrollView.frame = view.bounds
    scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scrollView.accessibilityIdentifier = "settings-scroll"
    view.addSubview(scrollView)

    content.axis = .vertical
    content.spacing = 16
    content.alignment = .leading
    content.translatesAutoresizingMaskIntoConstraints = false
    scrollView.addSubview(content)
    NSLayoutConstraint.activate([
      content.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
      content.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
      content.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
      content.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -16),
      content.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32),
    ])

    let heading = UILabel()
    heading.text = "Game options"
    heading.font = .systemFont(ofSize: 22, weight: .bold)
    heading.accessibilityTraits = .header
    content.addArrangedSubview(heading)

    let body = UILabel()
    body.text = "Pick a seed and a mode, then start."
    body.font = .systemFont(ofSize: 17)
    body.numberOfLines = 0
    content.addArrangedSubview(body)

    // Planted: low contrast.
    let hint = UILabel()
    hint.text = "Seed hint"
    hint.font = .systemFont(ofSize: 15)
    hint.textColor = UIColor(red: 0xBB / 255, green: 0xBB / 255, blue: 0xBB / 255, alpha: 1)
    content.addArrangedSubview(hint)

    // Planted: unlabelled text field (no placeholder, no accessibilityLabel).
    let seed = UITextField()
    seed.borderStyle = .roundedRect
    seed.text = "1234"
    seed.widthAnchor.constraint(equalToConstant: 160).isActive = true
    content.addArrangedSubview(seed)

    // Planted: truncated single-line label.
    let truncated = UILabel()
    truncated.text = "Truncated line: this sentence is far longer than the two hundred points it is given"
    truncated.font = .systemFont(ofSize: 15)
    truncated.numberOfLines = 1
    truncated.widthAnchor.constraint(equalToConstant: 200).isActive = true
    content.addArrangedSubview(truncated)

    let buttons = UIStackView()
    buttons.axis = .horizontal
    buttons.spacing = 12
    let start = makeButton("Start", color: .brandBlue)
    start.addTarget(self, action: #selector(startTapped), for: .touchUpInside)
    let next = makeButton("Next", color: .systemGray)
    next.isEnabled = false
    buttons.addArrangedSubview(start)
    buttons.addArrangedSubview(next)
    // Planted: image-only button with no label.
    let gear = UIButton(type: .system)
    gear.setImage(drawnGlyph(), for: .normal)
    gear.widthAnchor.constraint(equalToConstant: 44).isActive = true
    gear.heightAnchor.constraint(equalToConstant: 44).isActive = true
    buttons.addArrangedSubview(gear)
    content.addArrangedSubview(buttons)

    let status = UILabel()
    status.text = "Ready"
    status.font = .systemFont(ofSize: 17)
    status.accessibilityIdentifier = "status"
    content.addArrangedSubview(status)
    self.status = status

    // Planted: two 20x20 buttons. "Info" touches the 44pt "Add" before it, so the 24pt circle
    // 2.5.8's spacing exception draws on it runs into a neighbour — undersized. "Help" sits
    // 4pt after "Info" with 120pt of room, and is excused by that exception.
    let tiny = UIStackView()
    tiny.axis = .horizontal
    tiny.spacing = 0
    let add = makeButton("Add", color: .brandBlue)
    let info = makeButton("Info", color: .brandBlue, size: 20)
    let help = makeButton("Help", color: .brandBlue, size: 20)
    tiny.addArrangedSubview(add)
    tiny.addArrangedSubview(info)
    tiny.addArrangedSubview(spacer(width: 4))
    tiny.addArrangedSubview(help)
    tiny.addArrangedSubview(spacer(width: 120))
    tiny.alignment = .center
    content.addArrangedSubview(tiny)

    // Planted: a 17pt button inside a 44pt operable row.
    let row = RowControl(frame: .zero)
    row.heightAnchor.constraint(equalToConstant: 44).isActive = true
    row.widthAnchor.constraint(equalToConstant: 300).isActive = true
    let place = makeButton("Place here", color: .brandBlue, size: 17)
    place.frame = CGRect(x: 12, y: 13, width: 90, height: 17)
    row.addSubview(place)
    content.addArrangedSubview(row)

    let toggleRow = UIStackView()
    toggleRow.axis = .horizontal
    toggleRow.spacing = 12
    let toggleLabel = UILabel()
    toggleLabel.text = "Notifications"
    let toggle = UISwitch()
    toggle.accessibilityLabel = "Notifications"
    toggleRow.addArrangedSubview(toggleLabel)
    toggleRow.addArrangedSubview(toggle)
    content.addArrangedSubview(toggleRow)

    let open = makeButton("Open profile", color: .brandBlue)
    open.addTarget(self, action: #selector(openProfile), for: .touchUpInside)
    content.addArrangedSubview(open)

    // Planted: a log past the fold in a plain view — nothing scrolls to it.
    let log = UIView(frame: CGRect(x: 16, y: 1100, width: 300, height: 140))
    log.accessibilityIdentifier = "log"
    for i in 1...5 {
      let line = UILabel(frame: CGRect(x: 0, y: (i - 1) * 24, width: 300, height: 22))
      line.text = "log \(i)"
      line.font = .systemFont(ofSize: 15)
      log.addSubview(line)
    }
    view.addSubview(log)
  }

  private weak var status: UILabel?

  @objc private func startTapped() {
    status?.text = "Started"
  }

  @objc private func openProfile() {
    navigationController?.pushViewController(UIHostingController(rootView: ProfileView()), animated: false)
  }

  private func makeButton(_ title: String, color: UIColor, size: CGFloat = 44) -> UIButton {
    let button = UIButton(type: .system)
    button.setTitle(title, for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: size < 44 ? 9 : 17)
    button.setTitleColor(.white, for: .normal)
    button.backgroundColor = color
    button.layer.cornerRadius = 6
    button.contentEdgeInsets = size < 44 ? .zero : UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
    button.heightAnchor.constraint(equalToConstant: size).isActive = true
    if size < 44 { button.widthAnchor.constraint(equalToConstant: size).isActive = true }
    return button
  }

  private func spacer(width: CGFloat) -> UIView {
    let v = UIView()
    v.widthAnchor.constraint(equalToConstant: width).isActive = true
    return v
  }
}

/// A bitmap with no name: SF Symbols announce themselves ("Gear shape"), a drawn image does not.
func drawnGlyph() -> UIImage {
  let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24))
  return renderer.image { ctx in
    UIColor.brandBlue.setStroke()
    let path = UIBezierPath(ovalIn: CGRect(x: 3, y: 3, width: 18, height: 18))
    path.lineWidth = 3
    path.stroke()
  }.withRenderingMode(.alwaysOriginal)
}

extension UIColor {
  /// White on this is 7.0:1; white on `.systemBlue` is 3.5:1, which would be a finding of its own.
  static let brandBlue = UIColor(red: 0, green: 0.33, blue: 0.80, alpha: 1)
}
