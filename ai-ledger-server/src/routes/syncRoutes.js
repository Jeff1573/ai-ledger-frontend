import { Router } from 'express'
import { z } from 'zod'
import { isIncomingNewerOrEqual } from '../lib/lww.js'
import { toISOTextOrNow } from '../lib/time.js'
import {
  createOptionalAuthMiddleware,
  createRequireAuthMiddleware,
} from '../middleware/auth.js'

// AI 配置写入请求体。
const aiConfigSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  base_url: z.string().trim().min(1, 'base_url 不能为空'),
  token: z.string().trim().min(1, 'token 不能为空'),
  provider_models: z.any().optional(),
  updated_at: z.string().optional(),
  created_at: z.string().optional(),
})

// 类别预设写入请求体。
const categorySchema = z.object({
  category_presets: z.array(z.any()),
  updated_at: z.string().optional(),
  created_at: z.string().optional(),
})

// 账单同步上行单条记录。
const ledgerEntrySchema = z.object({
  id: z.string().trim().min(1, '账单 id 不能为空'),
  amount: z.coerce.number().positive('金额必须大于 0'),
  currency: z.string().trim().min(1).default('CNY'),
  occurred_at: z.string().trim().min(1, 'occurred_at 不能为空'),
  location: z.string().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  merchant: z.string().nullable().optional(),
  category: z.string().trim().min(1),
  note: z.string().nullable().optional(),
  transaction_type: z.enum(['expense', 'income']),
  source_image_name: z.string().nullable().optional(),
  ai_provider: z.enum(['openai', 'anthropic']),
  ai_model: z.string().nullable().optional(),
  ai_confidence: z.coerce.number().nullable().optional(),
  is_deleted: z.coerce.boolean().optional(),
  deleted_at: z.string().nullable().optional(),
  created_at: z.string().trim().min(1, 'created_at 不能为空'),
  updated_at: z.string().trim().min(1, 'updated_at 不能为空'),
})

// 账单同步上推请求体。
const ledgerPushSchema = z.object({
  entries: z.array(ledgerEntrySchema).max(1000, '单次同步条数过多'),
})

/**
 * 规范化 AI 配置行结构。
 *
 * @param {string} userId 用户 ID。
 * @param {z.infer<typeof aiConfigSchema>} payload 请求体。
 * @returns {{
 *   user_id: string,
 *   provider: 'openai' | 'anthropic',
 *   base_url: string,
 *   token: string,
 *   provider_models: unknown,
 *   created_at: string,
 *   updated_at: string
 * }} 规范化行对象。
 */
function normalizeAiConfigRow(userId, payload) {
  return {
    user_id: userId,
    provider: payload.provider,
    base_url: payload.base_url.trim(),
    token: payload.token.trim(),
    provider_models:
      payload.provider_models && typeof payload.provider_models === 'object'
        ? payload.provider_models
        : {},
    created_at: toISOTextOrNow(payload.created_at),
    updated_at: toISOTextOrNow(payload.updated_at),
  }
}

/**
 * 规范化类别预设行结构。
 *
 * @param {string} userId 用户 ID。
 * @param {z.infer<typeof categorySchema>} payload 请求体。
 * @returns {{
 *   user_id: string,
 *   category_presets: unknown[],
 *   created_at: string,
 *   updated_at: string
 * }} 规范化行对象。
 */
function normalizeCategoryRow(userId, payload) {
  return {
    user_id: userId,
    category_presets: payload.category_presets,
    created_at: toISOTextOrNow(payload.created_at),
    updated_at: toISOTextOrNow(payload.updated_at),
  }
}

/**
 * 规范化账单上推记录。
 *
 * @param {string} userId 用户 ID。
 * @param {z.infer<typeof ledgerEntrySchema>} entry 原始账单。
 * @returns {Record<string, any>} 规范化后的账单对象。
 */
function normalizeLedgerRow(userId, entry) {
  const isDeleted = entry.is_deleted === true
  const deletedAt = isDeleted ? toISOTextOrNow(entry.deleted_at) : null
  return {
    user_id: userId,
    id: entry.id,
    amount: entry.amount,
    currency: entry.currency,
    occurred_at: toISOTextOrNow(entry.occurred_at),
    location: entry.location || null,
    payment_method: entry.payment_method || null,
    merchant: entry.merchant || null,
    category: entry.category,
    note: entry.note || null,
    transaction_type: entry.transaction_type,
    source_image_name: entry.source_image_name || null,
    ai_provider: entry.ai_provider,
    ai_model: entry.ai_model || null,
    ai_confidence: Number.isFinite(entry.ai_confidence) ? entry.ai_confidence : null,
    is_deleted: isDeleted,
    deleted_at: deletedAt,
    created_at: toISOTextOrNow(entry.created_at),
    updated_at: toISOTextOrNow(entry.updated_at),
  }
}

/**
 * 拉取当前用户的 AI 配置。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @param {string} userId 用户 ID。
 * @returns {Promise<Record<string, any> | null>} AI 配置行。
 */
async function fetchAiConfig(dbPool, userId) {
  const result = await dbPool.query(
    `
    select user_id, provider, base_url, token, provider_models, created_at, updated_at
    from ai_configs
    where user_id = $1
    `,
    [userId],
  )
  return result.rows[0] || null
}

/**
 * 拉取当前用户的类别预设。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @param {string} userId 用户 ID。
 * @returns {Promise<Record<string, any> | null>} 类别预设行。
 */
async function fetchCategoryPresets(dbPool, userId) {
  const result = await dbPool.query(
    `
    select user_id, category_presets, created_at, updated_at
    from user_preferences
    where user_id = $1
    `,
    [userId],
  )
  return result.rows[0] || null
}

/**
 * 创建同步路由。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @returns {import('express').Router} 路由实例。
 */
export function createSyncRouter(dbPool) {
  const router = Router()
  const optionalAuth = createOptionalAuthMiddleware(dbPool)
  const requireAuth = createRequireAuthMiddleware()

  router.use(optionalAuth, requireAuth)

  router.get('/ai-config', async (req, res, next) => {
    try {
      const row = await fetchAiConfig(dbPool, req.authUser.id)
      res.json({ item: row })
    } catch (error) {
      next(error)
    }
  })

  router.put('/ai-config', async (req, res, next) => {
    const client = await dbPool.connect()
    let transactionStarted = false
    try {
      const payload = aiConfigSchema.parse(req.body || {})
      const userId = req.authUser.id
      const incomingRow = normalizeAiConfigRow(userId, payload)

      await client.query('begin')
      transactionStarted = true
      const existingResult = await client.query(
        `
        select user_id, provider, base_url, token, provider_models, created_at, updated_at
        from ai_configs
        where user_id = $1
        `,
        [userId],
      )
      const existingRow = existingResult.rows[0]

      let persistedRow = existingRow
      if (!existingRow) {
        const inserted = await client.query(
          `
          insert into ai_configs(
            user_id, provider, base_url, token, provider_models, created_at, updated_at
          ) values($1, $2, $3, $4, $5, $6, $7)
          returning user_id, provider, base_url, token, provider_models, created_at, updated_at
          `,
          [
            incomingRow.user_id,
            incomingRow.provider,
            incomingRow.base_url,
            incomingRow.token,
            incomingRow.provider_models,
            incomingRow.created_at,
            incomingRow.updated_at,
          ],
        )
        persistedRow = inserted.rows[0]
      } else if (isIncomingNewerOrEqual(incomingRow.updated_at, existingRow.updated_at)) {
        const updated = await client.query(
          `
          update ai_configs
          set
            provider = $2,
            base_url = $3,
            token = $4,
            provider_models = $5,
            updated_at = $6
          where user_id = $1
          returning user_id, provider, base_url, token, provider_models, created_at, updated_at
          `,
          [
            userId,
            incomingRow.provider,
            incomingRow.base_url,
            incomingRow.token,
            incomingRow.provider_models,
            incomingRow.updated_at,
          ],
        )
        persistedRow = updated.rows[0]
      }
      await client.query('commit')

      res.json({
        item: persistedRow,
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query('rollback')
      }
      next(error)
    } finally {
      client.release()
    }
  })

  router.get('/category-presets', async (req, res, next) => {
    try {
      const row = await fetchCategoryPresets(dbPool, req.authUser.id)
      res.json({ item: row })
    } catch (error) {
      next(error)
    }
  })

  router.put('/category-presets', async (req, res, next) => {
    const client = await dbPool.connect()
    let transactionStarted = false
    try {
      const payload = categorySchema.parse(req.body || {})
      const userId = req.authUser.id
      const incomingRow = normalizeCategoryRow(userId, payload)

      await client.query('begin')
      transactionStarted = true
      const existingResult = await client.query(
        `
        select user_id, category_presets, created_at, updated_at
        from user_preferences
        where user_id = $1
        `,
        [userId],
      )
      const existingRow = existingResult.rows[0]

      let persistedRow = existingRow
      if (!existingRow) {
        const inserted = await client.query(
          `
          insert into user_preferences(
            user_id, category_presets, created_at, updated_at
          ) values($1, $2, $3, $4)
          returning user_id, category_presets, created_at, updated_at
          `,
          [
            incomingRow.user_id,
            incomingRow.category_presets,
            incomingRow.created_at,
            incomingRow.updated_at,
          ],
        )
        persistedRow = inserted.rows[0]
      } else if (isIncomingNewerOrEqual(incomingRow.updated_at, existingRow.updated_at)) {
        const updated = await client.query(
          `
          update user_preferences
          set
            category_presets = $2,
            updated_at = $3
          where user_id = $1
          returning user_id, category_presets, created_at, updated_at
          `,
          [userId, incomingRow.category_presets, incomingRow.updated_at],
        )
        persistedRow = updated.rows[0]
      }
      await client.query('commit')
      res.json({
        item: persistedRow,
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query('rollback')
      }
      next(error)
    } finally {
      client.release()
    }
  })

  router.post('/ledger/push', async (req, res, next) => {
    const client = await dbPool.connect()
    let transactionStarted = false
    try {
      const payload = ledgerPushSchema.parse(req.body || {})
      const userId = req.authUser.id
      const entries = payload.entries.map((entry) => normalizeLedgerRow(userId, entry))

      if (entries.length === 0) {
        res.json({
          items: [],
          pushedCount: 0,
        })
        return
      }

      await client.query('begin')
      transactionStarted = true
      const items = []
      let pushedCount = 0

      for (const entry of entries) {
        const existingResult = await client.query(
          `
          select id, updated_at
          from ledger_entries
          where user_id = $1 and id = $2
          `,
          [userId, entry.id],
        )
        const existingRow = existingResult.rows[0]

        if (!existingRow) {
          await client.query(
            `
            insert into ledger_entries(
              user_id, id, amount, currency, occurred_at, location, payment_method, merchant,
              category, note, transaction_type, source_image_name, ai_provider, ai_model,
              ai_confidence, is_deleted, deleted_at, created_at, updated_at
            ) values (
              $1, $2, $3, $4, $5, $6, $7, $8,
              $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19
            )
            `,
            [
              entry.user_id,
              entry.id,
              entry.amount,
              entry.currency,
              entry.occurred_at,
              entry.location,
              entry.payment_method,
              entry.merchant,
              entry.category,
              entry.note,
              entry.transaction_type,
              entry.source_image_name,
              entry.ai_provider,
              entry.ai_model,
              entry.ai_confidence,
              entry.is_deleted,
              entry.deleted_at,
              entry.created_at,
              entry.updated_at,
            ],
          )
          pushedCount += 1
          items.push({
            id: entry.id,
            updated_at: entry.updated_at,
          })
          continue
        }

        if (isIncomingNewerOrEqual(entry.updated_at, existingRow.updated_at)) {
          await client.query(
            `
            update ledger_entries
            set
              amount = $3,
              currency = $4,
              occurred_at = $5,
              location = $6,
              payment_method = $7,
              merchant = $8,
              category = $9,
              note = $10,
              transaction_type = $11,
              source_image_name = $12,
              ai_provider = $13,
              ai_model = $14,
              ai_confidence = $15,
              is_deleted = $16,
              deleted_at = $17,
              created_at = $18,
              updated_at = $19
            where user_id = $1 and id = $2
            `,
            [
              entry.user_id,
              entry.id,
              entry.amount,
              entry.currency,
              entry.occurred_at,
              entry.location,
              entry.payment_method,
              entry.merchant,
              entry.category,
              entry.note,
              entry.transaction_type,
              entry.source_image_name,
              entry.ai_provider,
              entry.ai_model,
              entry.ai_confidence,
              entry.is_deleted,
              entry.deleted_at,
              entry.created_at,
              entry.updated_at,
            ],
          )
          pushedCount += 1
          items.push({
            id: entry.id,
            updated_at: entry.updated_at,
          })
          continue
        }

        items.push({
          id: entry.id,
          updated_at: toISOTextOrNow(existingRow.updated_at),
        })
      }

      await client.query('commit')
      res.json({
        items,
        pushedCount,
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query('rollback')
      }
      next(error)
    } finally {
      client.release()
    }
  })

  router.get('/ledger/pull', async (req, res, next) => {
    try {
      const userId = req.authUser.id
      const queryLimit = Number.parseInt(String(req.query.limit || ''), 10)
      const limit = Number.isInteger(queryLimit)
        ? Math.max(1, Math.min(queryLimit, 1000))
        : 1000

      const updatedAfterRaw =
        typeof req.query.updatedAfter === 'string' ? req.query.updatedAfter.trim() : ''
      const hasUpdatedAfter = Boolean(updatedAfterRaw)
      const updatedAfter = hasUpdatedAfter ? toISOTextOrNow(updatedAfterRaw) : ''
      const hasCursorIdQuery =
        hasUpdatedAfter && Object.prototype.hasOwnProperty.call(req.query, 'cursorId')
      const cursorId =
        typeof req.query.cursorId === 'string' ? req.query.cursorId.trim() : ''

      const result = hasUpdatedAfter
        ? hasCursorIdQuery
          ? await dbPool.query(
              `
              select *
              from ledger_entries
              where
                user_id = $1
                and (
                  updated_at > $2
                  or (updated_at = $2 and id > $3)
                )
              order by updated_at asc, id asc
              limit $4
              `,
              [userId, updatedAfter, cursorId, limit],
            )
          : await dbPool.query(
              `
              select *
              from ledger_entries
              where user_id = $1 and updated_at > $2
              order by updated_at asc, id asc
              limit $3
              `,
              [userId, updatedAfter, limit],
            )
        : await dbPool.query(
            `
            select *
            from ledger_entries
            where user_id = $1
            order by updated_at asc, id asc
            limit $2
            `,
            [userId, limit],
          )

      res.json({
        items: result.rows,
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}
