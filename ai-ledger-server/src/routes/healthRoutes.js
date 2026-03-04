import { Router } from 'express'

/**
 * 创建健康检查路由。
 *
 * @param {import('pg').Pool} dbPool 数据库连接池。
 * @returns {import('express').Router} 路由实例。
 */
export function createHealthRouter(dbPool) {
  const router = Router()

  router.get('/', async (_req, res, next) => {
    try {
      await dbPool.query('select 1 as ok')
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}

