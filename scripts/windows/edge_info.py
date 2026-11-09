"""Read installed stable Edge and its startup profile without launching it."""
import json
import os
from pathlib import Path
import winreg

candidates = []
for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', 0, winreg.KEY_READ | view) as key:
                value, _ = winreg.QueryValueEx(key, None)
                candidates.append(Path(os.path.expandvars(value.strip('"'))))
        except FileNotFoundError:
            pass
for variable in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'):
    if os.environ.get(variable):
        candidates.append(Path(os.environ[variable]) / 'Microsoft/Edge/Application/msedge.exe')
executable = next((path.resolve() for path in candidates if path.is_file()), None)
if executable is None:
    raise RuntimeError('No installed Microsoft Edge executable was found')
root = Path(os.environ['LOCALAPPDATA']) / 'Microsoft/Edge/User Data'
state = json.loads((root / 'Local State').read_text(encoding='utf-8'))
profile = state.get('profile', {})
default = profile.get('last_used')
registered = profile.get('info_cache', {})
if not isinstance(default, str) or default not in registered or not (root / default).is_dir():
    raise RuntimeError('Edge startup profile cannot be established from its current Local State')
print(json.dumps({'executable': str(executable), 'user_data_dir': str(root.resolve()),
                  'default_profile_directory': default,
                  'profiles': [{'profile_directory': name, 'name': item.get('name')}
                               for name, item in registered.items()]}, ensure_ascii=False))
