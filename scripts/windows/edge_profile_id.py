"""Read only this Bridge's stored identity in an explicit physical Edge profile."""
import json
from pathlib import Path
import sys
from uuid import UUID

from dfindexeddb.leveldb import definitions, record

root = Path(sys.argv[1]).resolve()
directory = sys.argv[2]
if directory in ('', '.', '..') or '/' in directory or '\\' in directory:
    raise ValueError('Use one physical profile directory name')
profile = root / directory
preferences = json.loads((profile / 'Secure Preferences').read_text(encoding='utf-8'))
extension_path = Path(__file__).resolve().parents[2] / 'extension'
installed = [(key, item) for key, item in preferences.get('extensions', {}).get('settings', {}).items()
             if isinstance(item.get('path'), str) and Path(item['path']).resolve() == extension_path]
if len(installed) != 1:
    raise RuntimeError('This Bridge extension is not uniquely installed in the selected physical profile')
extension_id, _ = installed[0]
database = record.FolderReader(profile / 'Local Extension Settings' / extension_id)
latest = max((item.record for item in database.GetRecords(use_sequence_number=True)
              if item.record.key == b'bridgeProfileId'), key=lambda item: item.sequence_number, default=None)
if latest is None or latest.record_type != definitions.InternalRecordType.VALUE:
    raise RuntimeError('The selected Bridge has not stored its profile identity')
identity = json.loads(latest.value)
if not isinstance(identity, str) or str(UUID(identity)) != identity:
    raise RuntimeError('The stored Bridge profile identity is invalid')
print(json.dumps({'profile_id': identity, 'profile_directory': directory}))
