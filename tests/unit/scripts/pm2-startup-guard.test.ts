import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Windows PM2 startup guard', () => {
  it('pins PM2_HOME and generates a mkdir-lock guarded resurrect script', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'install-windows-pm2-startup.ps1'), 'utf-8');

    expect(script).toContain("$pm2Home = 'C:\\Users\\steve\\.pm2'");
    expect(script).toContain('set "PM2_HOME=$pm2Home"');
    // Regression guard: the stale-lock sweep $p assignment MUST be backtick-escaped
    // in the here-string, else it expands to empty at install-time and the
    // generated .cmd sweep silently no-ops (Gemini delta-review finding 2026-06-02).
    expect(script).toContain("`$p = Join-Path `$env:PM2_HOME");
    expect(script).toContain("TotalMinutes -gt 5");
    expect(script).toContain("Remove-Item -LiteralPath `$p -Recurse -Force");
    expect(script).toContain('mkdir "%PM2_HOME%\\resurrect.lock" 2>NUL || exit /b 0');
    expect(script).toContain('"$node" "$pm2Bin" ping >NUL 2>&1');
    expect(script).toContain('"$node" "$pm2Bin" resurrect');
    expect(script).toContain('rmdir "%PM2_HOME%\\resurrect.lock" 2>NUL');
    expect(script).toContain('New-ScheduledTaskAction -Execute $env:ComSpec');
  });
});
