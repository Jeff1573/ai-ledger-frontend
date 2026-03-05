// 已迁移为服务端单一数据源：保留最小内存壳层以兼容历史导入。
const appMetaMap = new Map()
const ledgerMap = new Map()

export async function getAppMetaRecord(key) {
  if (!appMetaMap.has(key)) {
    return undefined
  }
  return {
    key,
    value: appMetaMap.get(key),
  }
}

export async function putAppMetaRecord(record) {
  appMetaMap.set(record.key, record.value)
  return record.key
}

export async function bulkUpsertLedgerEntries(entries) {
  for (const entry of entries || []) {
    if (entry?.id) {
      ledgerMap.set(entry.id, { ...entry })
    }
  }
}

export async function upsertLedgerEntry(entry) {
  if (entry?.id) {
    ledgerMap.set(entry.id, { ...entry })
    return entry.id
  }
  return ''
}

export async function listAllLedgerEntriesDesc() {
  return [...ledgerMap.values()].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
}

export async function listAllLedgerEntriesRaw() {
  return [...ledgerMap.values()].map((entry) => ({ ...entry }))
}

export async function listRecentLedgerEntriesDesc(limit) {
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 30
  return (await listAllLedgerEntriesDesc()).slice(0, normalizedLimit)
}

export async function listLedgerEntriesInRangeDesc(startISO, endISO) {
  const startMs = new Date(startISO).getTime()
  const endMs = new Date(endISO).getTime()
  return (await listAllLedgerEntriesDesc()).filter((entry) => {
    const occurredAtMs = new Date(entry.occurredAt).getTime()
    return occurredAtMs >= startMs && occurredAtMs < endMs
  })
}

export async function listLedgerEntriesUpdatedAfterAsc(updatedAfterISO) {
  const thresholdMs = new Date(updatedAfterISO || 0).getTime()
  return [...ledgerMap.values()]
    .filter((entry) => new Date(entry.updatedAt).getTime() > thresholdMs)
    .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
}

export async function clearLedgerDbForTest() {
  appMetaMap.clear()
  ledgerMap.clear()
}
