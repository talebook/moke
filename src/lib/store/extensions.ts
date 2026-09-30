'use client';

import { create } from 'zustand';
import {
  Package,
  ChartLine,
  BarChart3,
  Clock,
  Cloud,
  Database,
  FileText,
  Globe,
  Monitor,
  BookOpen,
  Search,
  Star,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单个拓展的摘要信息（与 Rust 端 ExtensionInfo 对应）。 */
export interface ExtensionInfo {
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  enabled: boolean;
  /** 拓展后端端口（仅 enabled 时有效） */
  port: number;
  permissions: string[];
  sidebar: { label: string; icon: string; order: number } | null;
  hasBackend: boolean;
  hasUi: boolean;
  trust: ExtensionTrust;
}

export interface ExtensionTrust {
  signatureStatus: 'trusted' | 'unknown_publisher' | 'unsigned' | 'invalid';
  publisherId: string | null;
  publisherName: string | null;
  source: string | null;
  keyId: string | null;
  packageDigest: string;
  trusted: boolean;
  requiresApproval: boolean;
  blockedReason: string | null;
  risks: string[];
  permissionsAdded: string[];
  permissionsRemoved: string[];
  upgradeFrom: string | null;
}

export interface ExtensionApproval {
  packageDigest: string;
}

interface ExtensionState {
  extensions: ExtensionInfo[];
  loaded: boolean;
  loadExtensions: () => Promise<void>;
  enableExtension: (name: string, approval?: ExtensionApproval) => Promise<void>;
  disableExtension: (name: string) => Promise<void>;
  uninstallExtension: (name: string) => Promise<void>;
  /** 返回已启用且有 sidebar 声明的拓展，按 order 排序。 */
  getSidebarExtensions: () => ExtensionInfo[];
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const isTauri = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

// 拓展系统只在桌面 Tauri 存在：OHOS/移动端单 WebView 构建里 `ext_*`
// 命令没有注册（lib.rs 用 `#[cfg(not(target_env = "ohos"))]` 排除）。
// NEXT_PUBLIC_APP_PLATFORM 无法区分桌面与 OHOS（都是 'tauri'），
// 因此需要运行时平台检测，避免在 OHOS 上调用未注册的命令。
let extensionsRuntimeChecked = false;
let extensionsRuntimeAvailable = false;

async function canUseExtensions(): Promise<boolean> {
  if (!isTauri) return false;
  if (!extensionsRuntimeChecked) {
    extensionsRuntimeChecked = true;
    try {
      const { getMokeRuntimePlatform, isSingleWebviewRuntime } = await import('@/lib/moke-reader');
      const platform = await getMokeRuntimePlatform();
      extensionsRuntimeAvailable = !isSingleWebviewRuntime(platform);
    } catch {
      // 兼容旧桌面后端：运行时检测失败时按桌面处理
      extensionsRuntimeAvailable = true;
    }
  }
  return extensionsRuntimeAvailable;
}

async function invokeExt<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!(await canUseExtensions())) return [] as unknown as T;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function getSidebarExtensions(extensions: ExtensionInfo[]): ExtensionInfo[] {
  return extensions
    .filter((e) => e.enabled && e.sidebar !== null)
    .sort((a, b) => (a.sidebar?.order ?? 100) - (b.sidebar?.order ?? 100));
}

/** Rust 返回的 snake_case 拓展信息。 */
interface RawExtension {
  name: string;
  version: string;
  display_name: string;
  description: string;
  author: string;
  enabled: boolean;
  port: number;
  permissions: string[];
  sidebar: { label: string; icon: string; order: number } | null;
  has_backend: boolean;
  has_ui: boolean;
  trust: {
    signature_status: ExtensionTrust['signatureStatus'];
    publisher_id: string | null;
    publisher_name: string | null;
    source: string | null;
    key_id: string | null;
    package_digest: string;
    trusted: boolean;
    requires_approval: boolean;
    blocked_reason: string | null;
    risks: string[];
    permissions_added: string[];
    permissions_removed: string[];
    upgrade_from: string | null;
  };
}

function mapExtension(raw: RawExtension): ExtensionInfo {
  return {
    name: raw.name,
    version: raw.version,
    displayName: raw.display_name,
    description: raw.description,
    author: raw.author,
    enabled: raw.enabled,
    port: raw.port,
    permissions: raw.permissions,
    sidebar: raw.sidebar,
    hasBackend: raw.has_backend,
    hasUi: raw.has_ui,
    trust: {
      signatureStatus: raw.trust.signature_status,
      publisherId: raw.trust.publisher_id,
      publisherName: raw.trust.publisher_name,
      source: raw.trust.source,
      keyId: raw.trust.key_id,
      packageDigest: raw.trust.package_digest,
      trusted: raw.trust.trusted,
      requiresApproval: raw.trust.requires_approval,
      blockedReason: raw.trust.blocked_reason,
      risks: raw.trust.risks,
      permissionsAdded: raw.trust.permissions_added,
      permissionsRemoved: raw.trust.permissions_removed,
      upgradeFrom: raw.trust.upgrade_from,
    },
  };
}

// ---------------------------------------------------------------------------
// 图标解析
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, LucideIcon> = {
  'chart-line': ChartLine,
  'bar-chart-3': BarChart3,
  clock: Clock,
  cloud: Cloud,
  database: Database,
  'file-text': FileText,
  globe: Globe,
  monitor: Monitor,
  'book-open': BookOpen,
  search: Search,
  star: Star,
  users: Users,
  wrench: Wrench,
};

/** 根据 manifest 中声明的图标名获取 Lucide 图标。未找到则返回 Package。 */
export function resolveExtensionIcon(iconName: string): LucideIcon {
  return ICON_MAP[iconName] ?? Package;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useExtensionStore = create<ExtensionState>()((set, get) => ({
  extensions: [],
  loaded: false,

  loadExtensions: async () => {
    try {
      const list = await invokeExt<RawExtension[]>('ext_list_extensions');
      const mapped = (Array.isArray(list) ? list : []).map(mapExtension);
      set({ extensions: mapped, loaded: true });
    } catch (e) {
      console.error('[extensions] 加载拓展列表失败:', e);
    }
  },

  enableExtension: async (name: string, approval?: ExtensionApproval) => {
    await invokeExt('ext_enable_extension', {
      name,
      approval: approval ? { package_digest: approval.packageDigest } : null,
    });
    await get().loadExtensions();
  },

  disableExtension: async (name: string) => {
    await invokeExt('ext_disable_extension', { name });
    await get().loadExtensions();
  },

  uninstallExtension: async (name: string) => {
    await invokeExt('ext_uninstall_extension', { name });
    await get().loadExtensions();
  },

  getSidebarExtensions: () => getSidebarExtensions(get().extensions),
}));
