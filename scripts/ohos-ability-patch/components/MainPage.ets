import { DefaultXComponent } from "./DefaultXComponent";

export const RouteName = "RustAbility";

interface BackwardCapable {
  backwardIfPossible: () => boolean;
}

@Entry({ routeName: RouteName })
@Component
struct Index {
  /**
   * Page-level back interception: when any WebView can navigate back, go
   * back and consume the event so the app stays in the foreground. Without
   * history, return false so the event falls through to the UIAbility's
   * onBackPressed.
   */
  onBackPress(): boolean {
    const controller = AppStorage.get<BackwardCapable>(
      "ohos.rs.ability.webviewController",
    );
    if (controller && typeof controller.backwardIfPossible === "function") {
      return controller.backwardIfPossible();
    }
    return false;
  }

  build() {
    Row() {
      Column() {
        DefaultXComponent()
      }.width("100%")
    }.height("100%");
  }
}
