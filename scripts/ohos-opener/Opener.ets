import { common, wantConstant } from '@kit.AbilityKit';
import { fileUri } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';

interface OpenRequest {
  id: number;
  kind: string;
  value: string;
}

interface NativeOpener {
  registerOhosOpener(callback: (payload: string) => void): void;
  completeOhosOpener(id: number, error: string | null): void;
  isOhosOpenerPending(id: number): boolean;
  unregisterOhosOpener(): void;
}

// Deliberately not exported to the WebView. Only EntryAbility can install this
// adapter; every request has already passed the Rust plugin's ACL/scope checks.
export class OhosOpener {
  private native: NativeOpener | null = null;

  install(context: common.UIAbilityContext, moduleName: string): void {
    const native = loadNativeModule(`lib${moduleName}.so`) as NativeOpener;
    this.native = native;
    native.registerOhosOpener((payload: string): void => {
      this.dispatch(context, native, payload);
    });
  }

  dispose(): void {
    this.native?.unregisterOhosOpener();
    this.native = null;
  }

  private async dispatch(context: common.UIAbilityContext, native: NativeOpener,
    payload: string): Promise<void> {
    const request = JSON.parse(payload) as OpenRequest;
    if (this.native !== native || !native.isOhosOpenerPending(request.id)) return;
    try {
      if (request.kind === 'url') {
        const scheme = request.value.split(':')[0].toLowerCase();
        if (scheme === 'http' || scheme === 'https') {
          await context.openLink(request.value);
        } else if (scheme === 'tel') {
          // Open the dialer; never directly place a call or request CALL_PHONE.
          await context.startAbility({ action: 'ohos.want.action.dial', uri: request.value });
        } else if (scheme === 'mailto') {
          await context.startAbility({ action: 'ohos.want.action.sendToData', uri: request.value });
        } else {
          throw new Error('Unsupported OHOS URL scheme');
        }
      } else if (request.kind === 'path') {
        await context.startAbility({
          action: 'ohos.want.action.viewData',
          uri: fileUri.getUriFromPath(request.value),
          type: mimeType(request.value),
          flags: wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION,
        });
      } else {
        throw new Error('Unsupported OHOS opener request');
      }
      native.completeOhosOpener(request.id, null);
    } catch (error) {
      const failure = error as BusinessError;
      native.completeOhosOpener(request.id, `OHOS opener ${failure.code ?? ''}: ${failure.message}`);
    }
  }
}

function mimeType(path: string): string {
  const extension = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'epub': return 'application/epub+zip';
    case 'pdf': return 'application/pdf';
    case 'txt': return 'text/plain';
    case 'html': case 'htm': return 'text/html';
    case 'mobi': return 'application/x-mobipocket-ebook';
    case 'azw': case 'azw3': return 'application/vnd.amazon.ebook';
    case 'fb2': return 'application/x-fictionbook+xml';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    default: return 'application/octet-stream';
  }
}
