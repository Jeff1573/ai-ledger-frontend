import Dexie from 'dexie'

// 本地账本数据库名称；固定命名用于后续版本平滑升级。
const LEDGER_DB_NAME = 'ai_accounting_db'
// 账单表名称。
const LEDGER_TABLE_NAME = 'ledgerEntries'
// 应用元数据表名称（用于迁移标记等轻量状态）。
const APP_META_TABLE_NAME = 'appMeta'

/**
 * Dexie 账本数据库定义，集中维护表结构与索引。
 */
class LedgerDatabase extends Dexie {
  constructor() {
    super(LEDGER_DB_NAME)
    // v1：账单按 occurredAt 查询最频繁，因此建立独立索引；其余字段为后续图表聚合预留。
    this.version(1).stores({
      [LEDGER_TABLE_NAME]: 'id, occurredAt, createdAt, category, transactionType',
      [APP_META_TABLE_NAME]: 'key',
    })

    this.ledgerEntries = this.table(LEDGER_TABLE_NAME)
    this.appMeta = this.table(APP_META_TABLE_NAME)
  }
}

// 全局单例，避免多实例并发打开同一 IndexedDB。
const ledgerDb = new LedgerDatabase()

/**
 * 确保 Dexie 连接已打开；测试删除数据库后可自动恢复连接。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function ensureDbOpen() {
  if (ledgerDb.isOpen()) {
    return
  }
  await ledgerDb.open()
}

/**
 * 读取 appMeta 元数据记录。
 *
 * @param {string} key 元数据键名。
 * @returns {Promise<{key: string, value: string} | undefined>} 元数据记录。
 */
export async function getAppMetaRecord(key) {
  await ensureDbOpen()
  return ledgerDb.appMeta.get(key)
}

/**
 * 写入 appMeta 元数据记录。
 *
 * @param {{key: string, value: string}} record 待写入记录。
 * @returns {Promise<string>} 被写入的主键。
 */
export async function putAppMetaRecord(record) {
  await ensureDbOpen()
  return ledgerDb.appMeta.put(record)
}

/**
 * 批量写入账单记录（存在则覆盖）。
 *
 * @param {Array<object>} entries 待写入账单。
 * @returns {Promise<void>} 无返回值。
 */
export async function bulkUpsertLedgerEntries(entries) {
  await ensureDbOpen()
  if (!Array.isArray(entries) || entries.length === 0) {
    return
  }
  await ledgerDb.ledgerEntries.bulkPut(entries)
}

/**
 * 写入单条账单记录（存在则覆盖）。
 *
 * @param {object} entry 待写入账单。
 * @returns {Promise<string>} 账单主键 ID。
 */
export async function upsertLedgerEntry(entry) {
  await ensureDbOpen()
  return ledgerDb.ledgerEntries.put(entry)
}

/**
 * 按发生时间倒序读取全部账单。
 *
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listAllLedgerEntriesDesc() {
  await ensureDbOpen()
  return ledgerDb.ledgerEntries.orderBy('occurredAt').reverse().toArray()
}

/**
 * 按发生时间倒序读取最近 N 条账单。
 *
 * @param {number} limit 最大条数。
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listRecentLedgerEntriesDesc(limit) {
  await ensureDbOpen()
  return ledgerDb.ledgerEntries.orderBy('occurredAt').reverse().limit(limit).toArray()
}

/**
 * 按发生时间范围读取账单（结果倒序）。
 *
 * @param {string} startISO 起始 ISO（含）。
 * @param {string} endISO 结束 ISO（不含）。
 * @returns {Promise<Array<object>>} 账单列表。
 */
export async function listLedgerEntriesInRangeDesc(startISO, endISO) {
  await ensureDbOpen()
  return ledgerDb.ledgerEntries
    .where('occurredAt')
    .between(startISO, endISO, true, false)
    .reverse()
    .toArray()
}

/**
 * 测试辅助：删除整个账本数据库，确保用例隔离。
 *
 * @returns {Promise<void>} 无返回值。
 */
export async function clearLedgerDbForTest() {
  await ledgerDb.delete()
}
