import { UIContext } from "@ohos.arkui.UIContext";
import web_webview from "@ohos.web.webview";
import { NodeController, BuilderNode, FrameNode } from "@ohos.arkui.node";
import { randomString } from "../helper";
import { OnDownloadStartResult } from "../ability/type";
import { getCookies, JsHelper } from "./Utils";
import { WebHeader } from "@kit.ArkUI";

export interface WebviewStyle {
  x?: number | string;
  y?: number | string;
  backgroundColor?: string | Color;
  visible?: string;
}

export interface WebviewInitData {
  webTag?: string;
  url: string;
  style?: WebviewStyle;
  controller?: WebviewController;
  javascriptEnable?: boolean;
  devtools?: boolean;
  autoplay?: boolean;
  userAgent?: string;
  initializationScripts?: ScriptItem[];
  headers?: Record<string, string>;
  html?: string;
  onDragAndDrop?: (event: string) => void;
  onDownloadStart?: (url: string, tempPath: string | undefined) => OnDownloadStartResult;
  onDownloadEnd?: (url: string, tempPath: string | undefined, success: boolean) => void;
  onNavigationRequest?: (url: string) => boolean;
  onTitleChange?: (title: string) => void;
}

interface WebviewNodeData extends WebviewInitData {
  controller: WebviewController;
}

@Builder
function WebBuilder(data: WebviewNodeData) {
  // init with empty url and reload with loadUrl or loadData with onControllerAttach
  Web({ src: "", controller: data.controller as web_webview.WebviewController })
    .width("100%")
    .height("100%")
    .position({
      x: data.style?.x || 0,
      y: data.style?.y || 0,
    })
    .backgroundColor(data?.style?.backgroundColor)
    .visibility(data?.style?.visible === "hidden" ? Visibility.Hidden : Visibility.Visible)
    .javaScriptAccess(data?.javascriptEnable)
    .mediaPlayGestureAccess(
      typeof data?.autoplay === "boolean" && data.autoplay === true ? false : true,
    )
    .javaScriptOnDocumentStart(data?.initializationScripts)
    .onControllerAttached(() => {
      const ctrl = data.controller;
      // load url or html string
      if (data?.url) {
        const header: WebHeader[] = Object.keys(
          (data?.headers || {}) as Record<string, string>,
        ).reduce((t: WebHeader[], i) => {
          t.push({ headerKey: i, headerValue: data.headers![i] } as WebHeader);
          return t;
        }, []);
        ctrl.loadUrl(data.url, header);
      } else {
        ctrl.loadData(data!.html, "text/html", "UTF-8", " ", " ");
      }
    })
    .onLoadIntercept((event) => {
      if (typeof data?.onNavigationRequest === "function") {
        const url = event.data.getRequestUrl();
        const ret = data.onNavigationRequest(url);
        return ret;
      }
      return false;
    })
    .onTitleReceive((e) => {
      if (typeof data?.onTitleChange === "function") {
        data.onTitleChange(e.title);
      }
    });
}

const webViewWrap = wrapBuilder<WebviewNodeData[]>(WebBuilder);

interface AddWebviewMethod {
  webTag: string;
  controller: JsHelper;
}

export class RustWebviewNodeController extends NodeController {
  private rootNode: FrameNode | null = null;
  private webviewList: Map<string, BuilderNode<WebviewNodeData[]>> = new Map();
  private webviewData: Map<string, JsHelper> = new Map();
  private uiContext: UIContext | null = null;

  constructor(uiContext: UIContext) {
    super();
    this.uiContext = uiContext;
  }

  private buildData(controller: WebviewController) {
    const getUrl = () => {
      return controller.getUrl();
    };
    const getCookiesHelper = (url: string) => {
      return getCookies(url) as string;
    };
    const loadUrl = (url: string, header?: Record<string, string>) => {
      const headers = Object.keys((header || {}) as Record<string, string>).reduce(
        (t, i) => {
          if (!!header![i]) {
            t.push({ headerKey: i, headerValue: header![i] });
          }
          return t;
        },
        [] as Array<WebHeader>,
      );
      controller.loadUrl(url, headers);
    };

    const loadHtml = (html: string) => {
      controller.loadData(html, "text/html", "UTF-8", " ", " ");
    };

    const zoom = (scale: number) => {
      controller.zoom(scale);
    };

    const refresh = () => {
      controller.refresh();
    };

    const requestFocus = () => {
      controller.requestFocus();
    };

    const back = () => {
      controller.backward();
    };

    const forward = () => {
      controller.forward();
    };

    const canGoBack = () => {
      return controller.accessBackward();
    };

    const canGoForward = () => {
      return controller.accessForward();
    };

    // Go back one history step when possible; returns true if the event was
    // consumed (used by the host EntryAbility's onBackPressed to keep the
    // app alive when the webview still has history to traverse).
    const backwardIfPossible = () => {
      if (controller.accessBackward()) {
        controller.backward();
        return true;
      }
      return false;
    };

    // clear browsing data
    const clearAllBrowsingData = () => {
      web_webview.WebStorage.deleteAllData(true);
      web_webview.WebDataBase.deleteHttpAuthCredentials();
      controller.removeCache(true);
      controller.clearHistory();
    };

    const runJavaScript = (code: string, cb: (result?: string) => void) => {
      controller.runJavaScript(code).then((ret) => {
        cb(ret);
      });
    };

    const data: JsHelper = {
      getUrl,
      getCookies: getCookiesHelper,
      loadUrl,
      loadHtml,
      zoom,
      refresh,
      requestFocus,
      back,
      forward,
      canGoBack,
      canGoForward,
      backwardIfPossible,
      clearAllBrowsingData,
      runJavaScript,
    } as JsHelper;
    return data;
  }

  makeNode(uiContext: UIContext): FrameNode {
    if (this.rootNode === null) {
      this.rootNode = new FrameNode(uiContext);
    }
    return this.rootNode;
  }

  addWebview(data: WebviewInitData): AddWebviewMethod {
    if (!data.webTag) {
      data.webTag = randomString();
    }
    if (!data.controller) {
      data.controller = new web_webview.WebviewController(data.webTag) as WebviewController;
    }

    if (this.rootNode === null) {
      this.rootNode = new FrameNode(this.uiContext!);
    }

    // Enabled devtools
    data?.devtools && web_webview.WebviewController.setWebDebuggingAccess(true);

    const node: BuilderNode<WebviewNodeData[]> = new BuilderNode(this.uiContext!);
    node.build(webViewWrap, data);
    this.webviewList.set(data.webTag, node);

    const controller = this.buildData(data.controller);
    // intercept download task
    if (typeof data?.onDownloadStart === "function" || typeof data?.onDownloadEnd === "function") {
      const download = new web_webview.WebDownloadDelegate();

      if (typeof data?.onDownloadStart === "function") {
        download.onBeforeDownload((e) => {
          const url = e.getUrl();
          const tempPath = e.getFullPath();
          const ret = data.onDownloadStart!(url, tempPath);

          if (ret.allow) {
            e.start(ret.tempPath || tempPath);
          } else {
            e.cancel();
          }
        });
      }

      if (typeof data?.onDownloadEnd === "function") {
        download.onDownloadFinish((e) => {
          const url = e.getUrl();
          const tempPath = e.getFullPath();
          data.onDownloadEnd!(url, tempPath, true);
        });
        download.onDownloadFailed((e) => {
          const url = e.getUrl();
          data.onDownloadEnd!(url, undefined, false);
        });
      }

      data.controller.setDownloadDelegate(download);
    }
    this.webviewData.set(data.webTag, controller);

    this.rootNode?.appendChild(node.getFrameNode());
    return {
      webTag: data.webTag,
      controller,
    };
  }

  getWebviewNode(webTag: string) {
    return this.webviewList.get(webTag);
  }
}

// extend WebviewController method
declare class WebviewController extends web_webview.WebviewController {
  getCookies: (url: string) => string;
  setBackgroundColor: (color: string) => void;
  setVisible: (visible: boolean) => void;
  clearAllBrowsingData: () => void;
}
