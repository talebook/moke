import { test, expect } from '@playwright/test';

test('ZIP review displays identity and permission diff; cancel and commit stay separate', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moke-server-storage', JSON.stringify({state:{offlineMode:true},version:0}));
    window.importCalls = [];
    const raw = {
      name:'sample',version:'2.0.0',display_name:'示例扩展',description:'ZIP 导入验证',author:'Example',enabled:false,port:0,permissions:['storage','server.info'],sidebar:null,has_backend:false,has_ui:false,
      trust:{signature_status:'unknown_publisher',publisher_id:'example',publisher_name:'示例作者',source:'https://example.org',key_id:'test',package_digest:'a'.repeat(64),trusted:false,requires_approval:true,blocked_reason:null,risks:['签名有效，但发布者未知'],permissions_added:['server.info'],permissions_removed:['reader.command.send'],upgrade_from:'1.0.0'},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command,args) => {
        if (command === 'moke_runtime_platform') return 'linux';
        if (command === 'ext_list_extensions') return [];
        if (command === 'ext_prepare_import') return {ticket:'test-ticket',extension:raw};
        if (command === 'ext_cancel_import' || command === 'ext_commit_import') { window.importCalls.push({command,args}); return; }
        if (command === 'plugin:app|version') return '1.1.4';
        return null;
      },
    };
  });
  await page.goto('/extensions');
  const consent=page.getByRole('button',{name:'同意并继续'});
  await expect(consent).toBeVisible();
  await consent.click();
  await page.getByRole('button',{name:'导入扩展',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('示例作者');
  await expect(dialog).toContainText('1.0.0 → 2.0.0');
  await expect(dialog).toContainText('新增权限：server.info');
  await expect(dialog).toContainText('移除权限：reader.command.send');
  await expect(dialog).toContainText('未知发布者');
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(()=>window.importCalls.some(c=>c.command==='ext_commit_import'))).toBe(false);
  await page.getByRole('button',{name:'导入扩展',exact:true}).click();
  await page.screenshot({path:'test-results/extension-import-preview.png',fullPage:true});
  await page.getByRole('button',{name:'确认升级',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('导入成功');
  expect(await page.evaluate(()=>window.importCalls.find(c=>c.command==='ext_commit_import').args)).toEqual({ticket:'test-ticket',packageDigest:'a'.repeat(64)});
});
