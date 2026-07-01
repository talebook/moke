// moke-ext package — create NSIS installer

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export default function pack() {
  const cwd = process.cwd();
  const manifestPath = join(cwd, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('No manifest.json found.');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const name = manifest.name;
  const dist = join(cwd, 'dist');

  if (!existsSync(dist)) {
    console.error('dist/ not found. Run "moke-ext build" first.');
    process.exit(1);
  }

  // Check for NSIS
  try { execSync('where makensis', { stdio: 'pipe' }); } catch {
    console.error('makensis not found in PATH. Install NSIS: https://nsis.sourceforge.io/Download');
    process.exit(1);
  }

  // Generate installer.nsi from template if not present
  const nsiPath = join(dist, 'installer.nsi');
  if (!existsSync(nsiPath)) {
    const nsi = generateNsi(manifest);
    writeFileSync(nsiPath, nsi);
    console.log('  Generated installer.nsi');
  }

  // Build
  console.log(`Packaging "${name}"...`);
  try {
    execSync(`makensis "${nsiPath}"`, { cwd: dist, stdio: 'inherit' });
  } catch {
    console.error('NSIS build failed.');
    process.exit(1);
  }

  const setup = join(dist, `${name}-setup.exe`);
  if (existsSync(setup)) {
    console.log(`\nPackage created: ${setup}`);
  }
}

function generateNsi(manifest) {
  const name = manifest.name;
  const display = manifest.display_name || name;
  const version = manifest.version || '1.0.0';
  const publisher = manifest.author || 'Unknown';

  return `!define EXT_NAME          "${name}"
!define EXT_DISPLAY_NAME  "${display}"
!define EXT_VERSION       "${version}"
!define EXT_PUBLISHER     "${publisher}"

!define MOKE_APP_ID       "com.moke.client"
!define MOKE_REG_KEY      "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Moke"
!define EXT_REG_KEY       "Software\\Moke\\Extensions\\\${EXT_NAME}"

Name "\${EXT_DISPLAY_NAME} v\${EXT_VERSION}"
OutFile "\${EXT_NAME}-setup.exe"
InstallDir "$APPDATA\\\${MOKE_APP_ID}\\extensions\\\${EXT_NAME}"
RequestExecutionLevel user

Function .onInit
    ReadRegStr $0 HKCU "\${MOKE_REG_KEY}" "DisplayName"
    StrCmp $0 "" 0 moke_found
    IfFileExists "$APPDATA\\\${MOKE_APP_ID}\\*" moke_found
    MessageBox MB_OK|MB_ICONSTOP "Moke is not installed. Please install Moke first."
    Abort
moke_found:
    ReadRegStr $0 HKCU "\${EXT_REG_KEY}" "Version"
    StrCmp $0 "" done
    MessageBox MB_YESNO|MB_ICONQUESTION "\${EXT_DISPLAY_NAME} v$0 is already installed. Overwrite?" IDYES done
    Abort
done:
FunctionEnd

Section "Install"
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"
    SetOutPath "$INSTDIR"
    File /r "*"

    Delete "$INSTDIR\\installer.nsi"
    Delete "$INSTDIR\\\${EXT_NAME}-setup.exe"

    WriteRegStr HKCU "\${EXT_REG_KEY}" "DisplayName" "\${EXT_DISPLAY_NAME}"
    WriteRegStr HKCU "\${EXT_REG_KEY}" "Version"     "\${EXT_VERSION}"
    WriteRegStr HKCU "\${EXT_REG_KEY}" "Publisher"   "\${EXT_PUBLISHER}"
    WriteRegStr HKCU "\${EXT_REG_KEY}" "Path"        "$INSTDIR"
    WriteRegStr HKCU "\${EXT_REG_KEY}" "Installed"   "1"

    WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}" \\
        "DisplayName" "\${EXT_DISPLAY_NAME}"
    WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}" \\
        "UninstallString" '"$INSTDIR\\uninstall.exe"'
    WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}" \\
        "Publisher" "\${EXT_PUBLISHER}"
    WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}" \\
        "DisplayVersion" "\${EXT_VERSION}"
    WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}" \\
        "NoModify" 1
    WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}" \\
        "NoRepair" 1

    WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd

Section "Uninstall"
    DeleteRegKey HKCU "\${EXT_REG_KEY}"
    DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${EXT_NAME}"
    RMDir /r "$INSTDIR"
SectionEnd
`;
}
