# @polsia:user-owned — SQLite prompt cache. Keyed on a canonical hash of the
# normalized (system, messages, model, max_tokens) tuple. Primary purpose: when
# ARTEX retries a failed task or re-runs an identical probe, we return the
# cached completion instead of burning another subscription-window call.
from __future__ import annotations

import hashlib
import json
import time
from typing import Any

import aiosqlite


class PromptCache:
    def __init__(self, *, path: str, ttl_seconds: int) -> None:
        self._path = path
        self._ttl = ttl_seconds
        self._db: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self._db = await aiosqlite.connect(self._path)
        await self._db.execute(
            "CREATE TABLE IF NOT EXISTS prompt_cache ("
            "  key TEXT PRIMARY KEY,"
            "  value TEXT NOT NULL,"
            "  stored_at REAL NOT NULL"
            ")"
        )
        await self._db.commit()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @staticmethod
    def _key(
        *, system: str, messages: list[dict[str, Any]], model: str | None, max_tokens: int
    ) -> str:
        payload = json.dumps(
            {"system": system, "messages": messages, "model": model, "max_tokens": max_tokens},
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    async def get(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
    ) -> dict[str, Any] | None:
        assert self._db is not None, "cache not opened"
        key = self._key(system=system, messages=messages, model=model, max_tokens=max_tokens)
        async with self._db.execute(
            "SELECT value, stored_at FROM prompt_cache WHERE key = ?", (key,)
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            return None
        value_json, stored_at = row
        if time.time() - stored_at > self._ttl:
            await self._db.execute("DELETE FROM prompt_cache WHERE key = ?", (key,))
            await self._db.commit()
            return None
        return json.loads(value_json)

    async def set(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
        value: dict[str, Any],
    ) -> None:
        assert self._db is not None, "cache not opened"
        key = self._key(system=system, messages=messages, model=model, max_tokens=max_tokens)
        await self._db.execute(
            "INSERT OR REPLACE INTO prompt_cache (key, value, stored_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), time.time()),
        )
        await self._db.commit()
