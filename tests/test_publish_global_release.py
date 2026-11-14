import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from scripts import publish_global_release as publish


class GlobalReleaseTests(unittest.TestCase):
    def test_paths_cannot_escape_snapshot(self):
        for path in ['../key', '/etc/keys']:
            with self.assertRaises(ValueError): publish.asset_name(path)

    def test_asset_digest_and_size_must_match(self):
        expected={'name':'test.parquet','size':10,'sha256':'abc'}
        asset={'state':'uploaded','size':10,'digest':'sha256:abc'}
        publish.verify_asset(asset,expected)
        for patch in [{'size':9},{'digest':'sha256:wrong'},{'state':'starter'}]:
            with self.assertRaises(ValueError):publish.verify_asset({**asset,**patch},expected)

    def test_snapshot_retains_old_inode_when_sync_replaces_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'data';root.mkdir();dest=Path(temporary)/'export'
            (root/'.sync.lock').touch();(root/'metadata').mkdir()
            source=root/'observations/year=2000/detections.parquet';source.parent.mkdir(parents=True)
            source.write_bytes(b'old snapshot')
            digest=hashlib.sha256(source.read_bytes()).hexdigest()
            item={'path':str(source.relative_to(root)),'kind':'observations','size':source.stat().st_size,'sha256':digest}
            state={'status':'ready','errors':[],'assets':{item['path']:item},'plan':[item],'updated_at':'2026-11-14',
                   'observation_rows':1,'notes':[]}
            (root/'manifest.json').write_text(json.dumps(state))
            plan=publish.prepare(root,dest,'test-snapshot')
            replacement=source.with_suffix('.part');replacement.write_bytes(b'new snapshot');replacement.replace(source)
            pinned=dest/publish.asset_name(item['path'])
            self.assertEqual(pinned.read_bytes(),b'old snapshot')
            self.assertEqual(publish.checksum(pinned),digest)
            self.assertEqual(plan,publish.prepare(root,dest,'test-snapshot'))
            for asset in plan['assets']:
                self.assertEqual(publish.checksum(dest/asset['name']),asset['sha256'])


if __name__=='__main__': unittest.main()
