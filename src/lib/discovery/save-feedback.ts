import type { SaveServerResult } from '../saved-server-api.ts';

interface SaveContext {
  cancelled: boolean;
  selectionCurrent: boolean;
  paused: boolean;
}

interface SaveFeedback {
  message: string;
  reloadRequired: boolean;
  focusEntryId?: string;
}

/** Report the durable result before the request's later UI cancellation. */
export function discoverySaveFeedback(result: SaveServerResult, context: SaveContext): SaveFeedback {
  if (!result.ok && result.outcome === 'storage-failure') {
    return {
      message: result.persistence === 'unknown'
        ? '保存结果尚未确认。请返回服务器列表重新加载核对，勿重复添加。'
        : '列表暂不能写入，请返回服务器列表重新加载核对后再试。',
      reloadRequired: true,
    };
  }
  if (result.ok) {
    if (context.cancelled || !context.selectionCurrent) {
      return { message: '已保存到服务器列表。请返回列表查看。', reloadRequired: true };
    }
    return { message: '', reloadRequired: false, focusEntryId: result.server.id };
  }
  const revoked = result.outcome === 'admission-rejected'
    && (result.code === 'cancelled' || result.code === 'stopped'
      || (context.paused && result.code === 'invalid_session'));
  if (context.cancelled || revoked) {
    return {
      message: context.paused
        ? '应用已在后台暂停，本次保存已取消。回到前台后请重新选择。'
        : '本次保存已取消，未写入服务器列表。请重新选择。',
      reloadRequired: false,
    };
  }
  return {
    message: '候选来源或地址校验未通过，未写入服务器列表。请重新查找后再试。',
    reloadRequired: false,
  };
}
