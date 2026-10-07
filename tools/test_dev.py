from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("dev.py")
SPEC = importlib.util.spec_from_file_location("sayuri_dev", MODULE_PATH)
assert SPEC and SPEC.loader
DEV = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEV)


class DevToolTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="sayuri-dev-test-"))
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "Sayuri Test"], cwd=root, check=True)
        (root / ".sayuri").mkdir()
        (root / "src" / "brain").mkdir(parents=True)
        (root / "tools").mkdir()
        (root / "src" / "brain" / "memory.ts").write_text("export const memory = 1;\n", encoding="utf-8")
        (root / "src" / "brain" / "memory.test.ts").write_text("// test\n", encoding="utf-8")
        (root / "package.json").write_text(json.dumps({"scripts": {"check": "echo ok"}}), encoding="utf-8")
        state = {
            "schema_version": 1,
            "project": "Sayuri Tsukishiro",
            "project_version": "0.1.82",
            "stage": "test",
            "task": {"id": "t1", "goal": "test", "owned_paths": ["src/brain/**"], "target_tests": [], "acceptance": []},
            "last_result": "UNKNOWN",
            "next_action": "next",
            "blockers": [],
        }
        (root / ".sayuri" / "dev_state.json").write_text(json.dumps(state), encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=root, check=True)
        return root

    def test_changed_files_and_related_test_selection(self) -> None:
        root = self.make_repo()
        index = DEV.build_index(root)
        DEV.write_json(root / DEV.INDEX_PATH, index)
        (root / "src" / "brain" / "memory.ts").write_text("export const memory = 2;\n", encoding="utf-8")
        self.assertEqual(DEV.changed_files(root), [".sayuri/dev_index.json", "src/brain/memory.ts"])
        self.assertEqual(DEV.related_tests(["src/brain/memory.ts"], index), ["src/brain/memory.test.ts"])

    def test_snapshot_is_live_and_compact(self) -> None:
        root = self.make_repo()
        snap = DEV.snapshot(root)
        self.assertEqual(snap["version"], "0.1.82")
        self.assertFalse(snap["dirty"])
        self.assertEqual(snap["next_action"], "next")
        self.assertTrue(snap["head"])

    def test_owned_paths_do_not_capture_unrelated_files(self) -> None:
        root = self.make_repo()
        state = DEV.load_state(root)
        owned = DEV._owned_changed_files(state, ["src/brain/memory.ts", "README.md"])
        self.assertEqual(owned, ["src/brain/memory.ts"])

    def test_json_validation_rejects_invalid_json(self) -> None:
        root = self.make_repo()
        broken = root / ".sayuri" / "broken.json"
        broken.write_text("{oops", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            DEV._validate_json_files(root, [".sayuri/broken.json"])


if __name__ == "__main__":
    unittest.main()
