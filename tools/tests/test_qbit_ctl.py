"""Unit tests for the pure helpers in tools/qbit-ctl (no Docker, no terminal).

Run: python3 -m unittest discover -s tools/tests
"""

import curses
import importlib.machinery
import importlib.util
import os
import re
import sqlite3
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("qbit_ctl", os.path.join(HERE, "..", "qbit-ctl"))
_spec = importlib.util.spec_from_loader("qbit_ctl", _loader)
q = importlib.util.module_from_spec(_spec)
_loader.exec_module(q)


class FakeScreen:
    """Feeds get_wch() from a list; raises curses.error when empty, like a timeout."""

    def __init__(self, keys):
        self.keys = list(keys)

    def timeout(self, ms):
        pass

    def get_wch(self):
        if not self.keys:
            raise curses.error("no input")
        return self.keys.pop(0)


class TextTests(unittest.TestCase):
    def test_display_width_counts_wide_characters_twice(self):
        self.assertEqual(q.dw("abc"), 3)
        self.assertEqual(q.dw("陳小明"), 6)
        self.assertEqual(q.dw("（測試）"), 8)

    def test_clip_respects_display_width(self):
        self.assertEqual(q.clip("hello world", 5), "hell…")
        self.assertEqual(q.clip("陳小明測試", 5), "陳小…")
        self.assertEqual(q.clip("short", 10), "short")
        self.assertEqual(q.clip("tab\there", 20), "tab here")

    def test_pad_aligns_by_display_width(self):
        self.assertEqual(q.pad("陳", 4), "陳  ")
        self.assertEqual(q.pad("7", 3, right=True), "  7")

    def test_cell_formats_null_and_timestamps(self):
        self.assertEqual(q.cell(None), "∅")
        self.assertEqual(q.cell(42), "42")
        self.assertEqual(q.cell("2026-11-11T10:16:25"), "2026-11-11 10:16")
        self.assertEqual(q.cell("2026-11-11T09:24:56.815Z"), "2026-11-11 09:24")
        self.assertEqual(q.cell("2026-01-01"), "2026-01-01")
        self.assertEqual(q.cell("O'Brien | pipe"), "O'Brien | pipe")

    def test_human_sizes(self):
        self.assertEqual(q.human(0), "0 B")
        self.assertEqual(q.human(2048), "2.0 KB")
        self.assertEqual(q.human(None), "-")

    def test_plural(self):
        self.assertEqual(q.plural(1, "row"), "1 row")
        self.assertEqual(q.plural(3, "row"), "3 rows")


class KeyTests(unittest.TestCase):
    def test_plain_character(self):
        self.assertEqual(q.getkey(FakeScreen(["a"])), ord("a"))

    def test_arrow_sequences_in_both_encodings(self):
        self.assertEqual(q.getkey(FakeScreen(["\x1b", "[", "B"])), curses.KEY_DOWN)
        self.assertEqual(q.getkey(FakeScreen(["\x1b", "O", "A"])), curses.KEY_UP)
        self.assertEqual(q.getkey(FakeScreen(["\x1b", "[", "5", "~"])), curses.KEY_PPAGE)

    def test_bare_escape(self):
        self.assertEqual(q.getkey(FakeScreen(["\x1b"])), 27)

    def test_timeout(self):
        self.assertEqual(q.getkey(FakeScreen([])), -1)


class QueryTests(unittest.TestCase):
    """Run every console query against the real schema from web/backend/src/db.ts."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "..", "..", "web", "backend", "src", "db.ts"), encoding="utf-8") as f:
            ts = f.read()
        cls.db = sqlite3.connect(":memory:")
        for stmt in re.findall(r"CREATE (?:TABLE|INDEX)[^;]+;", ts):
            cls.db.execute(stmt)
        for stmt in re.findall(r"ALTER TABLE \w+ ADD COLUMN [^'`]+", ts):
            try:
                cls.db.execute(stmt)
            except sqlite3.OperationalError:
                pass  # duplicate column: the CREATE TABLE already has it
        names = {r[0] for r in cls.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        for table, _ in q.COUNT_TABLES:
            if table not in names:
                raise AssertionError("COUNT_TABLES lists %s, which db.ts no longer creates" % table)

    def test_every_query_runs_and_matches_its_headers(self):
        for key, _, sql, cols in q.QUERIES:
            with self.subTest(query=key):
                cur = self.db.execute(sql)
                self.assertEqual(len(cur.description), len(cols))

    def test_query_keys_are_unique(self):
        keys = [k for k, _, _, _ in q.QUERIES]
        self.assertEqual(len(keys), len(set(keys)))


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cfg = os.path.join(self.tmp.name, "qbit-ctl", "config.ini")
        p = mock.patch.object(q, "CONFIG_FILE", cfg)
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch.dict(q.E, {}, clear=False)
        e.start()
        self.addCleanup(e.stop)
        q.E.pop("QBIT_CTL_BACKUP_DIR", None)

    def test_default_when_nothing_is_set(self):
        d, src = q.resolve_backup_dir()
        self.assertEqual(d, os.path.expanduser("~/qbit_backups"))
        self.assertEqual(src, "default")

    def test_saved_directory_is_used_and_other_settings_survive(self):
        os.makedirs(os.path.dirname(q.CONFIG_FILE))
        with open(q.CONFIG_FILE, "w") as f:
            f.write("[other]\nkey = value\n")
        q.save_backup_dir(os.path.join(self.tmp.name, "bk"))
        d, src = q.resolve_backup_dir()
        self.assertEqual(d, os.path.join(self.tmp.name, "bk"))
        self.assertEqual(q.read_config().get("other", "key"), "value")

    def test_environment_wins_over_config(self):
        q.save_backup_dir(os.path.join(self.tmp.name, "bk"))
        q.E["QBIT_CTL_BACKUP_DIR"] = "/srv/elsewhere"
        self.assertEqual(q.resolve_backup_dir(), ("/srv/elsewhere", "QBIT_CTL_BACKUP_DIR"))

    def test_clear_removes_the_file_when_nothing_else_is_left(self):
        q.save_backup_dir(os.path.join(self.tmp.name, "bk"))
        q.clear_backup_dir()
        self.assertFalse(os.path.exists(q.CONFIG_FILE))
        self.assertEqual(q.resolve_backup_dir()[1], "default")

    def test_clear_keeps_other_settings(self):
        os.makedirs(os.path.dirname(q.CONFIG_FILE))
        with open(q.CONFIG_FILE, "w") as f:
            f.write("[other]\nkey = value\n")
        q.save_backup_dir(os.path.join(self.tmp.name, "bk"))
        q.clear_backup_dir()
        self.assertEqual(q.read_config().get("other", "key"), "value")
        self.assertEqual(q.resolve_backup_dir()[1], "default")

    def test_percent_in_path_is_kept_literally(self):
        path = os.path.join(self.tmp.name, "bk%2026")
        q.save_backup_dir(path)
        self.assertEqual(q.resolve_backup_dir()[0], path)

    def test_non_utf8_config_falls_back_to_default(self):
        os.makedirs(os.path.dirname(q.CONFIG_FILE))
        with open(q.CONFIG_FILE, "wb") as f:
            f.write(b"[backups]\ndir = /x\xff\xfe\n")
        self.assertEqual(q.resolve_backup_dir()[1], "default")

    def test_broken_config_falls_back_to_default(self):
        os.makedirs(os.path.dirname(q.CONFIG_FILE))
        with open(q.CONFIG_FILE, "w") as f:
            f.write("not an ini file [")
        self.assertEqual(q.resolve_backup_dir()[1], "default")


class TableTests(unittest.TestCase):
    def test_widths_fit_the_room(self):
        t = q.Table(["Name", "Email"], [["陳小明（測試）", "someone@example.com"]])
        self.assertLessEqual(sum(t.widths(20)) + 2, 20)
        self.assertEqual(t.widths(200), [14, 19])

    def test_capped_columns_use_spare_room(self):
        t = q.Table(["Created", "Description"], [["2026-11-01 12:00", "x" * 120]])
        ws = t.widths(100)
        self.assertEqual(sum(ws) + 2, 100)

    def test_long_values_are_not_truncated_when_they_fit(self):
        name = "qbit-data-backup-20261111-184623-pre-restore.tar.gz"
        t = q.Table(["Archive", "Size"], [[name, "22.0 KB"]])
        self.assertEqual(t.widths(120)[0], len(name))


if __name__ == "__main__":
    unittest.main()
