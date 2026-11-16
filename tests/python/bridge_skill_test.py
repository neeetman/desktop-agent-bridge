import json
import tempfile
import unittest
from pathlib import Path

import bridge_skill
from bridge_paths import ROOT, source_file


class BridgeSkill(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / 'home'
        self.runtime = Path(self.temp.name) / 'runtime'
        self.revision = bridge_skill.skill_revision(ROOT)

    def tearDown(self):
        self.temp.cleanup()

    def targets(self):
        return bridge_skill.targets(self.home, {})

    def test_plan_writes_nothing_and_skips_antigravity_without_its_plugin(self):
        proposal = bridge_skill.plan(ROOT, self.home, env={})
        actions = {row['target']: row['action'] for row in proposal['targets']}
        self.assertEqual(actions, {'claude': 'create', 'agents': 'create', 'antigravity': 'skip'})
        self.assertFalse(self.home.exists())
        rows = {row['target']: row for row in proposal['targets']}
        self.assertEqual(rows['agents']['apps'], ['codex', 'deepseek'])

    def test_install_records_revision_and_is_idempotent(self):
        proposal = bridge_skill.install(ROOT, self.home, env={}, runtime=self.runtime)
        for key in ('claude', 'agents'):
            directory = self.targets()[key]
            self.assertEqual((directory / 'SKILL.md').read_bytes(), source_file(ROOT, 'desktop-bridge-skill.md').read_bytes())
            marker = json.loads((directory / bridge_skill.MARKER).read_text(encoding='utf8'))
            self.assertEqual(marker['revision'], self.revision)
            self.assertEqual(bridge_skill.status(directory, self.revision)['state'], 'current')
        record = json.loads((self.runtime / 'skills/installation.json').read_text(encoding='utf8'))
        self.assertEqual(set(record['targets']), {'claude', 'agents'})
        self.assertEqual(proposal['revision'], self.revision)
        again = bridge_skill.plan(ROOT, self.home, env={})
        self.assertEqual({row['target']: row['action'] for row in again['targets']}, {'claude': 'none', 'agents': 'none', 'antigravity': 'skip'})

    def test_outdated_or_edited_copies_are_backed_up_and_replaced(self):
        bridge_skill.install(ROOT, self.home, env={}, runtime=self.runtime)
        claude, agents = self.targets()['claude'], self.targets()['agents']
        (claude / 'SKILL.md').write_text('edited', encoding='utf8')
        marker = json.loads((agents / bridge_skill.MARKER).read_text(encoding='utf8'))
        marker['revision'] = '0' * 16
        (agents / bridge_skill.MARKER).write_text(json.dumps(marker), encoding='utf8')
        states = {row['target']: row['state'] for row in bridge_skill.plan(ROOT, self.home, env={})['targets']}
        self.assertEqual((states['claude'], states['agents']), ('modified', 'outdated'))
        proposal = bridge_skill.install(ROOT, self.home, ['claude', 'agents'], env={}, runtime=self.runtime)
        rows = {row['target']: row for row in proposal['targets']}
        self.assertEqual(Path(rows['claude']['backupDirectory'], 'SKILL.md').read_text(encoding='utf8'), 'edited')
        self.assertEqual(bridge_skill.status(claude, self.revision)['state'], 'current')
        self.assertEqual(bridge_skill.status(agents, self.revision)['state'], 'current')

    def test_never_replaces_an_unmanaged_skill_of_the_same_name(self):
        directory = self.targets()['claude']
        directory.mkdir(parents=True)
        (directory / 'SKILL.md').write_text('someone else', encoding='utf8')
        with self.assertRaisesRegex(RuntimeError, 'unmanaged'):
            bridge_skill.install(ROOT, self.home, env={}, runtime=self.runtime)
        self.assertEqual((directory / 'SKILL.md').read_text(encoding='utf8'), 'someone else')
        self.assertFalse(self.targets()['agents'].exists())


if __name__ == '__main__':
    unittest.main()
