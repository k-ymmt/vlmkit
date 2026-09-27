/*
 * vlmkit's iOS agent: a dylib the Simulator loads into the app under test.
 *
 *   SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=libvlmkit-ios-agent.dylib \
 *   SIMCTL_CHILD_VLMKIT_IOS_SOCKET=/tmp/vlmkit-ios/x.sock \
 *   xcrun simctl launch --terminate-running-process booted <bundle-id>
 *
 * The app needs no code of vlmkit's, no test target and no entitlement: `simctl launch`
 * passes `SIMCTL_CHILD_*` variables into the app's environment, and a simulator process
 * honours DYLD_INSERT_LIBRARIES (measured 2026-09-27 on iOS 27.0: it loads into Apple's own
 * Messages app). LLDB was the other candidate and is not used — `lldb -p` on a process
 * without get-task-allow is refused ("Not allowed to attach"), so it would cover only the
 * project's own debug builds.
 *
 * On load this serves a unix-domain socket at $VLMKIT_IOS_SOCKET (the simulator shares the
 * host's filesystem, so the host connects to the same path). One request per connection:
 * a JSON line in, a JSON line out. Everything that touches UIKit runs on the main thread.
 *
 *   {"cmd":"ping"}            → {"ok":true,"pid":…,"process":…,"screen":{…}}
 *   {"cmd":"dump"}            → the windows' view hierarchy plus every accessibility element,
 *                               as `vlmkit-ios-dump/1` (the host turns it into a
 *                               vlmkit-a11y/1 tree and a scene; nothing is judged here)
 *   {"cmd":"tap","x":…,"y":…} → a synthesized touch at that screen point (pt), through
 *                               hit-testing and the responder chain, KIF-style
 *
 * Units are points in the screen's fixed (portrait) coordinate space — what
 * `simctl io screenshot` paints, divided by the screen scale. Colours are `rgba(r,g,b,a)`.
 *
 * **The collector resolves, the judge decides.** This file reports what UIKit says: frames,
 * colours, fonts, labels, traits. Roles, operability and every verdict are the host's.
 */
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <pthread.h>
#include <errno.h>

#define VK_FORMAT @"vlmkit-ios-dump/1"
#define VK_MAX_DEPTH 96

static void VKLog(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
static void VKLog(NSString *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  NSString *s = [[NSString alloc] initWithFormat:fmt arguments:args];
  va_end(args);
  NSLog(@"[vlmkit-ios-agent] %@", s);
}

// ---------------------------------------------------------------------------
// JSON helpers

static NSNumber *VKNum(CGFloat v) {
  if (!isfinite(v)) return @0;
  return @(round((double)v * 100.0) / 100.0);
}

static NSDictionary *VKRect(CGRect r) {
  return @{ @"x": VKNum(r.origin.x), @"y": VKNum(r.origin.y), @"w": VKNum(r.size.width), @"h": VKNum(r.size.height) };
}

static id VKStr(NSString *s) {
  return s ? (id)s : (id)[NSNull null];
}

static id VKColor(UIColor *color, UITraitCollection *traits) {
  if (!color) return [NSNull null];
  UIColor *resolved = traits ? [color resolvedColorWithTraitCollection:traits] : color;
  CGFloat r = 0, g = 0, b = 0, a = 0;
  if (![resolved getRed:&r green:&g blue:&b alpha:&a]) {
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGColorRef converted = CGColorCreateCopyByMatchingToColorSpace(srgb, kCGRenderingIntentDefault, resolved.CGColor, NULL);
    CGColorSpaceRelease(srgb);
    if (!converted) return [NSNull null];
    const CGFloat *c = CGColorGetComponents(converted);
    size_t n = CGColorGetNumberOfComponents(converted);
    if (n >= 4) { r = c[0]; g = c[1]; b = c[2]; a = c[3]; }
    else if (n >= 2) { r = g = b = c[0]; a = c[1]; }
    CGColorRelease(converted);
  }
  return [NSString stringWithFormat:@"rgba(%d,%d,%d,%.3f)",
          (int)lround(fmin(fmax(r, 0), 1) * 255), (int)lround(fmin(fmax(g, 0), 1) * 255),
          (int)lround(fmin(fmax(b, 0), 1) * 255), (double)fmin(fmax(a, 0), 1)];
}

static id VKCGColor(CGColorRef c, UITraitCollection *traits) {
  if (!c) return [NSNull null];
  return VKColor([UIColor colorWithCGColor:c], traits);
}

static NSDictionary *VKFont(UIFont *font) {
  if (!font) return nil;
  NSDictionary *traits = [font.fontDescriptor objectForKey:UIFontDescriptorTraitsAttribute];
  NSNumber *weight = traits[UIFontWeightTrait];
  double w = weight ? weight.doubleValue : 0;
  int css;
  if (w <= -0.7) css = 100;
  else if (w <= -0.5) css = 200;
  else if (w <= -0.3) css = 300;
  else if (w < 0.15) css = 400;
  else if (w < 0.27) css = 500;
  else if (w < 0.36) css = 600;
  else if (w < 0.5) css = 700;
  else if (w < 0.6) css = 800;
  else css = 900;
  NSNumber *symbolic = traits[UIFontSymbolicTrait];
  if (symbolic && (symbolic.unsignedIntValue & UIFontDescriptorTraitBold) && css < 700) css = 700;
  return @{ @"size": VKNum(font.pointSize), @"weight": @(css), @"name": font.fontName ?: @"" };
}

// ---------------------------------------------------------------------------
// Accessibility

static NSArray<NSString *> *VKTraitNames(UIAccessibilityTraits t) {
  NSMutableArray *names = [NSMutableArray array];
  struct { UIAccessibilityTraits bit; NSString *name; } table[] = {
    { UIAccessibilityTraitButton, @"button" },
    { UIAccessibilityTraitLink, @"link" },
    { UIAccessibilityTraitHeader, @"header" },
    { UIAccessibilityTraitSearchField, @"searchField" },
    { UIAccessibilityTraitImage, @"image" },
    { UIAccessibilityTraitSelected, @"selected" },
    { UIAccessibilityTraitPlaysSound, @"playsSound" },
    { UIAccessibilityTraitKeyboardKey, @"keyboardKey" },
    { UIAccessibilityTraitStaticText, @"staticText" },
    { UIAccessibilityTraitSummaryElement, @"summaryElement" },
    { UIAccessibilityTraitNotEnabled, @"notEnabled" },
    { UIAccessibilityTraitUpdatesFrequently, @"updatesFrequently" },
    { UIAccessibilityTraitStartsMediaSession, @"startsMediaSession" },
    { UIAccessibilityTraitAdjustable, @"adjustable" },
    { UIAccessibilityTraitAllowsDirectInteraction, @"allowsDirectInteraction" },
    { UIAccessibilityTraitCausesPageTurn, @"causesPageTurn" },
    { UIAccessibilityTraitTabBar, @"tabBar" },
  };
  for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
    if (t & table[i].bit) [names addObject:table[i].name];
  }
  if (@available(iOS 17.0, *)) {
    if (t & UIAccessibilityTraitToggleButton) [names addObject:@"toggleButton"];
    if (t & UIAccessibilityTraitSupportsZoom) [names addObject:@"supportsZoom"];
  }
  return names;
}

static NSString *VKStringValue(id value) {
  if (!value || value == [NSNull null]) return nil;
  if ([value isKindOfClass:[NSString class]]) return value;
  if ([value isKindOfClass:[NSAttributedString class]]) return [value string];
  return [value description];
}

static NSDictionary *VKAx(NSObject *o) {
  NSMutableDictionary *ax = [NSMutableDictionary dictionary];
  ax[@"element"] = @(o.isAccessibilityElement);
  ax[@"label"] = VKStr(VKStringValue(o.accessibilityLabel));
  ax[@"value"] = VKStr(VKStringValue(o.accessibilityValue));
  ax[@"hint"] = VKStr(VKStringValue(o.accessibilityHint));
  NSString *identifier = nil;
  if ([o respondsToSelector:@selector(accessibilityIdentifier)]) identifier = [(id<UIAccessibilityIdentification>)o accessibilityIdentifier];
  ax[@"id"] = VKStr(identifier);
  UIAccessibilityTraits traits = o.accessibilityTraits;
  ax[@"traits"] = VKTraitNames(traits);
  ax[@"traitsRaw"] = @((unsigned long long)traits);
  ax[@"frame"] = VKRect(o.accessibilityFrame);
  // Where VoiceOver's double-tap lands: a Toggle's switch, not the middle of its row.
  CGPoint activation = o.accessibilityActivationPoint;
  ax[@"activation"] = @{ @"x": VKNum(activation.x), @"y": VKNum(activation.y) };
  ax[@"hidden"] = @(o.accessibilityElementsHidden);
  ax[@"modal"] = @(o.accessibilityViewIsModal);
  if (@available(iOS 13.0, *)) ax[@"interactive"] = @(o.accessibilityRespondsToUserInteraction);
  ax[@"customActions"] = @(o.accessibilityCustomActions.count);
  if (o.accessibilityContainerType != UIAccessibilityContainerTypeNone) ax[@"containerType"] = @(o.accessibilityContainerType);
  return ax;
}

/** The elements a container announces: `accessibilityElements`, else the indexed protocol. */
static NSArray *VKAxChildren(NSObject *o) {
  NSArray *elements = nil;
  @try {
    elements = o.accessibilityElements;
    if (elements == nil) {
      NSInteger n = [o accessibilityElementCount];
      if (n > 0 && n != NSNotFound && n < 10000) {
        NSMutableArray *list = [NSMutableArray arrayWithCapacity:(NSUInteger)n];
        for (NSInteger i = 0; i < n; i++) {
          id el = [o accessibilityElementAtIndex:i];
          if (el) [list addObject:el];
        }
        elements = list;
      }
    }
  } @catch (NSException *e) {
    VKLog(@"accessibilityElements of %@ threw: %@", NSStringFromClass([o class]), e.reason);
  }
  return elements ?: @[];
}

static NSDictionary *VKDumpView(UIView *v, id<UICoordinateSpace> space, NSMutableSet *seen, int depth);

/** A non-view accessibility element (UIAccessibilityElement, a SwiftUI node, …). */
static NSDictionary *VKDumpAxElement(NSObject *o, id<UICoordinateSpace> space, NSMutableSet *seen, int depth) {
  if ([o isKindOfClass:[UIView class]]) return VKDumpView((UIView *)o, space, seen, depth);
  NSValue *key = [NSValue valueWithNonretainedObject:o];
  if ([seen containsObject:key] || depth > VK_MAX_DEPTH) return nil;
  [seen addObject:key];
  NSMutableDictionary *d = [NSMutableDictionary dictionary];
  d[@"kind"] = @"ax";
  d[@"cls"] = NSStringFromClass([o class]);
  d[@"ax"] = VKAx(o);
  NSMutableArray *children = [NSMutableArray array];
  for (NSObject *child in VKAxChildren(o)) {
    NSDictionary *c = VKDumpAxElement(child, space, seen, depth + 1);
    if (c) [children addObject:c];
  }
  d[@"axElements"] = children;
  return d;
}

// ---------------------------------------------------------------------------
// Views

static NSDictionary *VKDumpView(UIView *v, id<UICoordinateSpace> space, NSMutableSet *seen, int depth) {
  NSValue *key = [NSValue valueWithNonretainedObject:v];
  if ([seen containsObject:key] || depth > VK_MAX_DEPTH) return nil;
  [seen addObject:key];
  UITraitCollection *traits = v.traitCollection;
  NSMutableDictionary *d = [NSMutableDictionary dictionary];
  d[@"kind"] = @"view";
  d[@"cls"] = NSStringFromClass([v class]);
  CGRect frame = v.window ? [v convertRect:v.bounds toCoordinateSpace:space] : v.frame;
  d[@"frame"] = VKRect(frame);
  d[@"hidden"] = @(v.hidden);
  d[@"alpha"] = VKNum(v.alpha);
  d[@"opaque"] = @(v.opaque);
  d[@"clips"] = @(v.clipsToBounds || v.layer.masksToBounds);
  d[@"interaction"] = @(v.userInteractionEnabled);
  d[@"bg"] = VKColor(v.backgroundColor, traits);
  CALayer *layer = v.layer;
  if (layer.cornerRadius > 0) d[@"corner"] = VKNum(layer.cornerRadius);
  if (layer.borderWidth > 0) {
    d[@"border"] = VKNum(layer.borderWidth);
    d[@"borderColor"] = VKCGColor(layer.borderColor, traits);
  }
  if (layer.shadowOpacity > 0 && layer.shadowColor) d[@"shadow"] = @YES;
  if (!v.backgroundColor && layer.backgroundColor) d[@"bg"] = VKCGColor(layer.backgroundColor, traits);
  if (v.tag != 0) d[@"tag"] = @(v.tag);

  if ([v isKindOfClass:[UIControl class]]) {
    UIControl *c = (UIControl *)v;
    d[@"control"] = @{ @"enabled": @(c.enabled), @"selected": @(c.selected), @"highlighted": @(c.highlighted) };
  }
  if ([v isKindOfClass:[UISwitch class]]) d[@"on"] = @(((UISwitch *)v).on);
  if ([v isKindOfClass:[UISlider class]]) d[@"sliderValue"] = VKNum(((UISlider *)v).value);
  if ([v isKindOfClass:[UIImageView class]]) {
    UIImage *img = ((UIImageView *)v).image;
    d[@"image"] = img ? VKRect(CGRectMake(0, 0, img.size.width, img.size.height)) : [NSNull null];
  }
  if ([v isKindOfClass:[UILabel class]]) {
    UILabel *l = (UILabel *)v;
    d[@"text"] = VKStr(l.text);
    d[@"font"] = VKFont(l.font) ?: [NSNull null];
    d[@"textColor"] = VKColor(l.textColor, traits);
    d[@"lines"] = @(l.numberOfLines);
    d[@"lineBreak"] = @(l.lineBreakMode);
    d[@"textAlign"] = @(l.textAlignment);
    d[@"textFits"] = VKRect((CGRect){ CGPointZero, [l sizeThatFits:CGSizeMake(l.bounds.size.width, CGFLOAT_MAX)] });
    d[@"textIntrinsic"] = VKRect((CGRect){ CGPointZero, l.intrinsicContentSize });
  } else if ([v isKindOfClass:[UITextField class]]) {
    UITextField *t = (UITextField *)v;
    d[@"text"] = VKStr(t.text);
    d[@"placeholder"] = VKStr(t.placeholder);
    d[@"font"] = VKFont(t.font) ?: [NSNull null];
    d[@"textColor"] = VKColor(t.textColor, traits);
    d[@"secure"] = @(t.secureTextEntry);
    d[@"borderStyle"] = @(t.borderStyle);
  } else if ([v isKindOfClass:[UITextView class]]) {
    UITextView *t = (UITextView *)v;
    d[@"text"] = VKStr(t.text);
    d[@"font"] = VKFont(t.font) ?: [NSNull null];
    d[@"textColor"] = VKColor(t.textColor, traits);
    d[@"editable"] = @(t.editable);
  } else if ([v isKindOfClass:[UIButton class]]) {
    UIButton *b = (UIButton *)v;
    d[@"title"] = VKStr(b.currentTitle);
    d[@"titleColor"] = VKColor(b.currentTitleColor, traits);
    d[@"hasImage"] = @(b.currentImage != nil);
  }
  if ([v isKindOfClass:[UIScrollView class]]) {
    UIScrollView *s = (UIScrollView *)v;
    d[@"scroll"] = @{
      @"offset": @{ @"x": VKNum(s.contentOffset.x), @"y": VKNum(s.contentOffset.y) },
      @"content": @{ @"w": VKNum(s.contentSize.width), @"h": VKNum(s.contentSize.height) },
      @"scrollEnabled": @(s.scrollEnabled),
    };
  }
  d[@"ax"] = VKAx(v);

  // What the view announces, first: `accessibilityElements` replaces the subviews for
  // VoiceOver, so a subview listed there is dumped here (and skipped below, by `seen`), and
  // one not listed stays a subview only — the host reads that difference. A SwiftUI hosting
  // view lists its nodes and the UIKit views it hosts (a text field, a switch) this way.
  NSMutableArray *axChildren = [NSMutableArray array];
  for (NSObject *el in VKAxChildren(v)) {
    NSDictionary *c = VKDumpAxElement(el, space, seen, depth + 1);
    if (c) [axChildren addObject:c];
  }
  d[@"axElements"] = axChildren;

  NSMutableArray *children = [NSMutableArray array];
  for (UIView *sub in v.subviews) {
    NSDictionary *c = VKDumpView(sub, space, seen, depth + 1);
    if (c) [children addObject:c];
  }
  d[@"children"] = children;
  return d;
}

static UIScreen *VKScreen(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:[UIWindowScene class]]) return ((UIWindowScene *)scene).screen;
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  return UIScreen.mainScreen;
#pragma clang diagnostic pop
}

static NSArray<UIWindow *> *VKWindows(void) {
  NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *w in ((UIWindowScene *)scene).windows) {
      if (![windows containsObject:w]) [windows addObject:w];
    }
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  for (UIWindow *w in UIApplication.sharedApplication.windows) {
    if (![windows containsObject:w]) [windows addObject:w];
  }
#pragma clang diagnostic pop
  [windows sortUsingComparator:^NSComparisonResult(UIWindow *a, UIWindow *b) {
    if (a.windowLevel == b.windowLevel) return NSOrderedSame;
    return a.windowLevel < b.windowLevel ? NSOrderedAscending : NSOrderedDescending;
  }];
  return windows;
}

static NSDictionary *VKScreenInfo(void) {
  UIScreen *screen = VKScreen();
  CGRect fixed = screen.fixedCoordinateSpace.bounds;
  return @{
    @"width": VKNum(fixed.size.width),
    @"height": VKNum(fixed.size.height),
    @"scale": VKNum(screen.scale),
    @"orientation": VKRect(screen.coordinateSpace.bounds),
  };
}

static NSDictionary *VKDump(void) {
  UIScreen *screen = VKScreen();
  id<UICoordinateSpace> space = screen.fixedCoordinateSpace;
  NSMutableSet *seen = [NSMutableSet set];
  NSMutableArray *windows = [NSMutableArray array];
  for (UIWindow *w in VKWindows()) {
    NSDictionary *d = VKDumpView(w, space, seen, 0);
    if (!d) continue;
    NSMutableDictionary *m = [d mutableCopy];
    m[@"windowLevel"] = VKNum(w.windowLevel);
    m[@"keyWindow"] = @(w.isKeyWindow);
    windows[windows.count] = m;
  }
  NSBundle *bundle = NSBundle.mainBundle;
  return @{
    @"format": VK_FORMAT,
    @"platform": @"ios-simulator",
    @"app": @{
      @"bundleId": bundle.bundleIdentifier ?: @"",
      @"process": NSProcessInfo.processInfo.processName,
      @"pid": @(NSProcessInfo.processInfo.processIdentifier),
      @"system": UIDevice.currentDevice.systemVersion,
    },
    @"screen": VKScreenInfo(),
    @"windows": windows,
  };
}

// ---------------------------------------------------------------------------
// Touch synthesis (the KIF technique: private UITouch / UIEvent setters plus an IOHIDEvent
// so that gesture recognizers, which read the HID event since iOS 9, see a real finger).

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef double IOHIDFloat;
typedef uint32_t IOOptionBits_;
typedef IOHIDEventRef (*VK_IOHIDEventCreateDigitizerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
  IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, Boolean, Boolean, IOOptionBits_);
typedef IOHIDEventRef (*VK_IOHIDEventCreateDigitizerFingerEventWithQuality)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
  IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat,
  IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, Boolean, Boolean, IOOptionBits_);
typedef void (*VK_IOHIDEventAppendEvent)(IOHIDEventRef, IOHIDEventRef);
typedef void (*VK_IOHIDEventSetIntegerValue)(IOHIDEventRef, uint32_t, int);

enum { kVKHIDTypeDigitizer = 11 };
enum { kVKTransducerHand = 3 };
enum { kVKDigitizerEventRange = 1, kVKDigitizerEventTouch = 2, kVKDigitizerEventPosition = 4 };
enum { kVKFieldDigitizerIsDisplayIntegrated = (kVKHIDTypeDigitizer << 16) + 25 };

@interface UITouch (VlmkitPrivate)
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)setTapCount:(NSUInteger)tapCount;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)setPhase:(UITouchPhase)phase;
- (void)setGestureView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)location resetPrevious:(BOOL)resetPrevious;
- (void)_setIsFirstTouchForView:(BOOL)first;
- (void)_setHidEvent:(IOHIDEventRef)event;
@end

@interface UIEvent (VlmkitPrivate)
- (void)_setHIDEvent:(IOHIDEventRef)event;
- (void)_clearTouches;
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
@end

@interface UIApplication (VlmkitPrivate)
- (UIEvent *)_touchesEvent;
@end

static BOOL VKHIDAvailable = NO;

static IOHIDEventRef VKHIDEvent(UITouch *touch, UITouchPhase phase) {
  static VK_IOHIDEventCreateDigitizerEvent createHand;
  static VK_IOHIDEventCreateDigitizerFingerEventWithQuality createFinger;
  static VK_IOHIDEventAppendEvent append;
  static VK_IOHIDEventSetIntegerValue setInt;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    createHand = dlsym(RTLD_DEFAULT, "IOHIDEventCreateDigitizerEvent");
    createFinger = dlsym(RTLD_DEFAULT, "IOHIDEventCreateDigitizerFingerEventWithQuality");
    append = dlsym(RTLD_DEFAULT, "IOHIDEventAppendEvent");
    setInt = dlsym(RTLD_DEFAULT, "IOHIDEventSetIntegerValue");
  });
  if (!createHand || !createFinger || !append || !setInt) return NULL;
  VKHIDAvailable = YES;
  uint64_t now = mach_absolute_time();
  IOHIDEventRef hand = createHand(kCFAllocatorDefault, now, kVKTransducerHand, 0, 0, kVKDigitizerEventTouch, 0, 0, 0, 0, 0, 0, false, true, 0);
  setInt(hand, kVKFieldDigitizerIsDisplayIntegrated, 1);
  uint32_t mask = phase == UITouchPhaseMoved ? kVKDigitizerEventPosition : (kVKDigitizerEventRange | kVKDigitizerEventTouch);
  Boolean touching = phase != UITouchPhaseEnded;
  CGPoint p = [touch locationInView:touch.window];
  IOHIDEventRef finger = createFinger(kCFAllocatorDefault, now, 1, 2, mask, p.x, p.y, 0, 0, 0, 5, 5, 1, 1, 1, touching, touching, 0);
  setInt(finger, kVKFieldDigitizerIsDisplayIntegrated, 1);
  append(hand, finger);
  CFRelease(finger);
  return hand;
}

static NSString *VKTouchUnsupported(void) {
  // The event class is UITouchesEvent, a private subclass: ask the instance, not UIEvent.
  NSArray<NSString *> *touchSelectors = @[@"_setLocationInWindow:resetPrevious:", @"setPhase:", @"setWindow:", @"setView:", @"setTapCount:", @"setTimestamp:"];
  for (NSString *s in touchSelectors) {
    if (![UITouch instancesRespondToSelector:NSSelectorFromString(s)]) return [NSString stringWithFormat:@"UITouch lacks %@", s];
  }
  if (![UIApplication.sharedApplication respondsToSelector:@selector(_touchesEvent)]) return @"UIApplication lacks _touchesEvent";
  UIEvent *event = [UIApplication.sharedApplication _touchesEvent];
  for (NSString *s in @[@"_clearTouches", @"_addTouch:forDelayedDelivery:"]) {
    if (![event respondsToSelector:NSSelectorFromString(s)]) return [NSString stringWithFormat:@"%@ lacks %@", NSStringFromClass([event class]), s];
  }
  return nil;
}

static void VKSend(UITouch *touch, UITouchPhase phase) {
  [touch setTimestamp:NSProcessInfo.processInfo.systemUptime];
  [touch setPhase:phase];
  IOHIDEventRef hid = VKHIDEvent(touch, phase);
  if (hid && [touch respondsToSelector:@selector(_setHidEvent:)]) [touch _setHidEvent:hid];
  UIEvent *event = [UIApplication.sharedApplication _touchesEvent];
  [event _clearTouches];
  if (hid && [event respondsToSelector:@selector(_setHIDEvent:)]) [event _setHIDEvent:hid];
  [event _addTouch:touch forDelayedDelivery:NO];
  [UIApplication.sharedApplication sendEvent:event];
  if (hid) CFRelease(hid);
}

/** Tap at a point in the screen's fixed coordinate space. Returns what was hit. */
static NSDictionary *VKTap(CGPoint screenPoint) {
  NSString *unsupported = VKTouchUnsupported();
  if (unsupported) return @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"touch synthesis unsupported on this iOS: %@", unsupported] };
  UIScreen *screen = VKScreen();
  UIWindow *window = nil;
  CGPoint inWindow = CGPointZero;
  UIView *hit = nil;
  for (UIWindow *w in [VKWindows() reverseObjectEnumerator]) {
    if (w.hidden || w.alpha == 0) continue;
    CGPoint p = [w convertPoint:screenPoint fromCoordinateSpace:screen.fixedCoordinateSpace];
    if (!CGRectContainsPoint(w.bounds, p)) continue;
    UIView *h = [w hitTest:p withEvent:nil];
    if (!h) continue;
    window = w; inWindow = p; hit = h;
    break;
  }
  if (!window) return @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"no window hit at %.1f,%.1f", screenPoint.x, screenPoint.y] };

  UITouch *touch = [[UITouch alloc] init];
  [touch setWindow:window];
  [touch setTapCount:1];
  [touch _setLocationInWindow:inWindow resetPrevious:YES];
  [touch setView:hit];
  [touch setPhase:UITouchPhaseBegan];
  if ([touch respondsToSelector:@selector(_setIsFirstTouchForView:)]) [touch _setIsFirstTouchForView:YES];
  if ([touch respondsToSelector:@selector(setGestureView:)]) [touch setGestureView:hit];
  VKSend(touch, UITouchPhaseBegan);
  // One frame between down and up, like a finger. Runs the main loop, so animations advance.
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
  VKSend(touch, UITouchPhaseEnded);
  NSMutableDictionary *hitInfo = [NSMutableDictionary dictionary];
  hitInfo[@"cls"] = NSStringFromClass([hit class]);
  hitInfo[@"label"] = VKStr(VKStringValue(hit.accessibilityLabel));
  hitInfo[@"frame"] = VKRect([hit convertRect:hit.bounds toCoordinateSpace:screen.fixedCoordinateSpace]);
  return @{ @"ok": @YES, @"hit": hitInfo, @"hid": @(VKHIDAvailable) };
}

// ---------------------------------------------------------------------------
// Requests

static NSDictionary *VKHandle(NSDictionary *req) {
  NSString *cmd = [req[@"cmd"] isKindOfClass:[NSString class]] ? req[@"cmd"] : @"";
  if ([cmd isEqualToString:@"ping"]) {
    return @{
      @"ok": @YES,
      @"pid": @(NSProcessInfo.processInfo.processIdentifier),
      @"process": NSProcessInfo.processInfo.processName,
      @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
      @"screen": VKScreenInfo(),
      @"windows": @(VKWindows().count),
    };
  }
  if ([cmd isEqualToString:@"dump"]) {
    NSMutableDictionary *d = [VKDump() mutableCopy];
    d[@"ok"] = @YES;
    return d;
  }
  if ([cmd isEqualToString:@"tap"]) {
    NSNumber *x = req[@"x"], *y = req[@"y"];
    if (![x isKindOfClass:[NSNumber class]] || ![y isKindOfClass:[NSNumber class]]) {
      return @{ @"ok": @NO, @"error": @"tap needs numeric x and y (screen points)" };
    }
    return VKTap(CGPointMake(x.doubleValue, y.doubleValue));
  }
  if ([cmd isEqualToString:@"methods"]) {
    // Reflection for the next iOS: which selectors a class really has.
    NSString *clsName = [req[@"cls"] isKindOfClass:[NSString class]] ? req[@"cls"] : @"";
    NSString *match = [req[@"match"] isKindOfClass:[NSString class]] ? req[@"match"] : @"";
    Class cls = NSClassFromString(clsName);
    if (!cls) return @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"no class %@", clsName] };
    NSMutableArray *names = [NSMutableArray array];
    for (Class c = cls; c; c = class_getSuperclass(c)) {
      unsigned int n = 0;
      Method *methods = class_copyMethodList(c, &n);
      for (unsigned int i = 0; i < n; i++) {
        NSString *name = NSStringFromSelector(method_getName(methods[i]));
        if (match.length == 0 || [name rangeOfString:match options:NSCaseInsensitiveSearch].location != NSNotFound) {
          [names addObject:[NSString stringWithFormat:@"%@ %@", NSStringFromClass(c), name]];
        }
      }
      free(methods);
      if (c == [NSObject class]) break;
    }
    return @{ @"ok": @YES, @"methods": names };
  }
  return @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"unknown cmd %@ (ping, dump, tap, methods)", cmd] };
}

static void VKServe(int client) {
  NSMutableData *buf = [NSMutableData data];
  char chunk[65536];
  for (;;) {
    ssize_t n = read(client, chunk, sizeof(chunk));
    if (n <= 0) break;
    [buf appendBytes:chunk length:(NSUInteger)n];
    if (memchr(chunk, '\n', (size_t)n)) break;
    if (buf.length > (1 << 20)) break;
  }
  NSDictionary *response;
  NSError *error = nil;
  id req = buf.length ? [NSJSONSerialization JSONObjectWithData:buf options:0 error:&error] : nil;
  if (![req isKindOfClass:[NSDictionary class]]) {
    response = @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"request is not a JSON object: %@", error.localizedDescription ?: @"empty"] };
  } else {
    __block NSDictionary *result = nil;
    dispatch_sync(dispatch_get_main_queue(), ^{
      @try {
        result = VKHandle(req);
      } @catch (NSException *e) {
        result = @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"%@: %@", e.name, e.reason ?: @""] };
      }
    });
    response = result;
  }
  NSData *out = [NSJSONSerialization dataWithJSONObject:response options:0 error:&error];
  if (!out) {
    NSString *fallback = [NSString stringWithFormat:@"{\"ok\":false,\"error\":\"response not serializable: %@\"}", error.localizedDescription];
    out = [fallback dataUsingEncoding:NSUTF8StringEncoding];
  }
  NSMutableData *line = [out mutableCopy];
  [line appendBytes:"\n" length:1];
  const uint8_t *p = line.bytes;
  size_t left = line.length;
  while (left > 0) {
    ssize_t w = write(client, p, left);
    if (w <= 0) break;
    p += w;
    left -= (size_t)w;
  }
}

static void *VKServerMain(void *arg) {
  const char *path = (const char *)arg;
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0) { VKLog(@"socket: %s", strerror(errno)); return NULL; }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr.sun_path)) { VKLog(@"socket path too long: %s", path); return NULL; }
  strcpy(addr.sun_path, path);
  unlink(path);
  if (bind(server, (struct sockaddr *)&addr, sizeof(addr)) < 0) { VKLog(@"bind %s: %s", path, strerror(errno)); return NULL; }
  if (listen(server, 8) < 0) { VKLog(@"listen: %s", strerror(errno)); return NULL; }
  VKLog(@"serving %s in %@ (pid %d)", path, NSProcessInfo.processInfo.processName, NSProcessInfo.processInfo.processIdentifier);
  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) { if (errno == EINTR) continue; break; }
    @autoreleasepool { VKServe(client); }
    close(client);
  }
  close(server);
  return NULL;
}

__attribute__((constructor)) static void VKAgentInit(void) {
  const char *path = getenv("VLMKIT_IOS_SOCKET");
  if (!path || !*path) { VKLog(@"VLMKIT_IOS_SOCKET not set; agent idle"); return; }
  pthread_t thread;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_create(&thread, &attr, VKServerMain, strdup(path));
  pthread_attr_destroy(&attr);
}
