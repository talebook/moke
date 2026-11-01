import type { DiscoveryRow } from '@/lib/discovery/types';

const UNAVAILABLE_TEXT: Record<string, string> = {
  hostname_unresolved: '此域名尚未通过本机地址解析校验，正在等待解析结果。',
  hostname_empty: '本机未解析到此域名的地址，可重新查找后重试。',
  hostname_lookup_failed: '本机域名解析失败，请检查网络后重新查找。',
  hostname_timeout: '本机域名解析超时，可重新查找后重试。',
  hostname_non_lan_address: '此域名解析结果包含局域网范围外的地址，暂不能添加。',
  hostname_address_mismatch: '此域名解析结果与当前广播地址不符，暂不能添加。',
};

export function DiscoveryResults({ rows }: { rows: DiscoveryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="mt-5 space-y-4" aria-label="发现的书库">
      {rows.map((row) => (
        <li key={row.id} className="app-card rounded-2xl border border-amber-950/10 p-4">
          <h2 className="break-words font-medium text-foreground">{row.name}</h2>
          <p className="mt-1 break-all text-xs text-muted-foreground">公开标识：{row.id}</p>
          {row.conflict && <p className="mt-2 text-sm text-destructive">同一标识出现不同名称，请核实各个地址。</p>}
          <ul className="mt-3 space-y-3" aria-label="候选地址">
            {row.candidates.map((candidate) => (
              <li key={candidate.baseUrl} className="rounded-xl border border-amber-950/10 p-3">
                <p className="break-words text-sm text-foreground">{candidate.name}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground" dir="ltr">{candidate.baseUrl}</p>
                {row.conflict && candidate.sources.map((source) => (
                  <p key={`${source.fullname}:${source.interface}`} className="mt-1 break-words text-xs text-muted-foreground">
                    来源名称：{source.name}（{source.interface}）
                  </p>
                ))}
                {!candidate.joinable && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {UNAVAILABLE_TEXT[candidate.unavailableReason ?? ''] ?? '此地址尚不可用于添加。'}
                  </p>
                )}
                {candidate.joinable && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    候选地址符合发现规则，服务器身份仍未验证。
                  </p>
                )}
                <button
                  type="button"
                  disabled
                  aria-describedby="discovery-save-unavailable"
                  className="mt-3 h-9 rounded-xl border border-amber-950/10 px-3 text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  添加到服务器列表
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
