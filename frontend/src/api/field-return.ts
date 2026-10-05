import { allRows, commitAll, listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 倾斜监测外业回传包：采集文件下载、回传逐条校验、整包原子写入、校时任务生成。
//
// 业务约定（需求里留待决定的口径都在这里）：
// - 同一测点重复上传：已校核/已归档的记录保留已校核版本，拒绝文件覆盖；
//   未校核（已观测/待校核/超限报警/需复测）的记录以最新原始记录为准，原位覆盖。
// - 缺失观测方向的旧数据一律按「未标注」参与匹配与展示。
// - 整包写入一次成功或全部退回：先逐条校验，全部通过后把倾斜记录与校时任务
//   拼成一份快照，用 commitAll 单次 setItem 落盘；任何一条不合格则什么都不写。
// - 已归档记录不能再被文件覆盖：最新记录已归档的测点整行拒绝，归档记录永不作为覆盖目标。

export const COORD_SYSTEM = 'CGCS2000'
export const UNMARKED_DIRECTION = '未标注'

const TILT_KEY = 'tilt'
const TIMECAL_KEY = 'device_timecal'

// 采集文件表头：坐标系、观测方向、上次累积量由平台带出，倾斜角度、观测人留空待现场补录。
const FILE_HEADER = ['测点编号', '坐标系', '观测方向', '上次累积量', '倾斜角度', '观测人']

export type TiltPointOption = {
  key: string // 「测点|方向」组成的选项键
  point: string
  direction: string
  baseline: number // 上次累积量
  archived: boolean // 最新记录已归档的测点禁止勾选、禁止回传
}

export type UploadResult = {
  ok: boolean
  message: string
  errors: string[]
  created: number
  replaced: number
  tasks: number
}

type ParsedRow = {
  lineNo: number
  point: string
  coord: string
  direction: string
  baseline: number | null
  angle: number | null
  observer: string
}

type WritePlan = {
  kind: 'insert' | 'replace'
  row: ParsedRow & { baseline: number; angle: number }
  direction: string
  latest: EntryRow | null // insert：该测点+方向当前最新记录
  target: EntryRow | null // replace：被覆盖的未校核记录
}

function directionOf(row: EntryRow): string {
  const raw = String(row['观测方向'] ?? '').trim()
  return raw === '' ? UNMARKED_DIRECTION : raw
}

function toNumber(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (text === '') {
    return null
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9
}

function round4(value: number): number {
  return Number(value.toFixed(4))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function nowText(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

function batchNo(): string {
  const now = new Date()
  return `RET-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

function latestRecord(rows: EntryRow[], point: string, direction: string): EntryRow | null {
  let found: EntryRow | null = null
  for (const row of rows) {
    if (String(row['测点编号'] ?? '').trim() !== point || directionOf(row) !== direction) {
      continue
    }
    if (!found || Number(row.id) > Number(found.id)) {
      found = row
    }
  }
  return found
}

/** 倾斜测点选项：按「测点×方向」取各自最新记录，供下载采集文件前勾选。 */
export function listTiltPoints(): TiltPointOption[] {
  const byKey = new Map<string, EntryRow>()
  for (const row of listRows(TILT_KEY)) {
    const point = String(row['测点编号'] ?? '').trim()
    if (!point) {
      continue
    }
    const key = `${point}|${directionOf(row)}`
    const prev = byKey.get(key)
    if (!prev || Number(row.id) > Number(prev.id)) {
      byKey.set(key, row)
    }
  }
  return [...byKey.entries()]
    .map(([key, row]) => ({
      key,
      point: String(row['测点编号']).trim(),
      direction: directionOf(row),
      baseline: toNumber(row['累积倾斜量']) ?? 0,
      archived: String(row.status) === '已归档',
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** 生成采集文件：每个选中的「测点×方向」一行，倾斜角度、观测人留空待补录。 */
export function buildCollectionFile(keys: string[]): { filename: string; content: string } {
  const selected = listTiltPoints().filter((item) => keys.includes(item.key) && !item.archived)
  const lines = [FILE_HEADER.join(',')]
  for (const item of selected) {
    lines.push([item.point, COORD_SYSTEM, item.direction, item.baseline, '', ''].join(','))
  }
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  return { filename: `倾斜外业采集包-${stamp}.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadCollectionFile(keys: string[]): string {
  const { filename, content } = buildCollectionFile(keys)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return filename
}

function parseCollection(content: string): { rows: ParsedRow[]; errors: string[] } {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    return { rows: [], errors: ['文件为空，没有可回传的数据'] }
  }
  const header = lines[0].split(',').map((cell) => cell.trim())
  const headerOk =
    header.length >= FILE_HEADER.length && FILE_HEADER.every((name, index) => header[index] === name)
  if (!headerOk) {
    return { rows: [], errors: [`表头应为：${FILE_HEADER.join(',')}，请使用平台下载的采集文件`] }
  }
  const rows: ParsedRow[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split(',').map((cell) => cell.trim())
    rows.push({
      lineNo: index + 1,
      point: cells[0] ?? '',
      coord: cells[1] ?? '',
      direction: cells[2] ?? '',
      baseline: toNumber(cells[3]),
      angle: toNumber(cells[4]),
      observer: cells[5] ?? '',
    })
  }
  if (rows.length === 0) {
    return { rows: [], errors: ['文件里只有表头，没有数据行'] }
  }
  return { rows, errors: [] }
}

/**
 * 回传上传：逐条校验 → 全部通过才整包落盘，否则整包退回。
 * 校验通过的行同时算出变化量（本次角度 − 基准角度）与累积倾斜量（上次累积量 + 变化量），
 * 落库即为「待校核」，走既有校核动作继续流转。
 */
export function uploadCollectionFile(content: string): UploadResult {
  const failed = (message: string, errors: string[]): UploadResult => ({
    ok: false,
    message,
    errors,
    created: 0,
    replaced: 0,
    tasks: 0,
  })

  const { rows: parsed, errors: parseErrors } = parseCollection(content)
  if (parseErrors.length > 0) {
    return failed('回传文件解析失败，整包已退回', parseErrors)
  }

  const tiltRows = listRows(TILT_KEY)
  const knownPoints = new Set(
    tiltRows.map((row) => String(row['测点编号'] ?? '').trim()).filter((point) => point !== ''),
  )
  const errors: string[] = []
  const plans: WritePlan[] = []
  const seenInPack = new Set<string>()

  for (const row of parsed) {
    const label = `第${row.lineNo}行`
    if (!row.point) {
      errors.push(`${label}：测点编号为空`)
      continue
    }
    if (!knownPoints.has(row.point)) {
      errors.push(`${label}：测点 ${row.point} 未在平台登记`)
      continue
    }
    if (row.coord !== COORD_SYSTEM) {
      errors.push(`${label}：坐标系「${row.coord || '空'}」与平台约定的 ${COORD_SYSTEM} 不一致`)
      continue
    }
    // 缺失方向按「未标注」兼容
    const direction = row.direction === '' ? UNMARKED_DIRECTION : row.direction
    if (row.baseline === null) {
      errors.push(`${label}：上次累积量缺失或不是数值`)
      continue
    }
    if (row.angle === null) {
      errors.push(`${label}：倾斜角度未补录或不是数值`)
      continue
    }
    if (!row.observer) {
      errors.push(`${label}：观测人未补录`)
      continue
    }
    const packKey = `${row.point}|${direction}`
    if (seenInPack.has(packKey)) {
      errors.push(`${label}：测点 ${row.point}（${direction}）在包内重复，请整理后重新上传`)
      continue
    }
    seenInPack.add(packKey)

    const checked = { ...row, baseline: row.baseline, angle: row.angle }
    const latest = latestRecord(tiltRows, row.point, direction)
    if (latest && String(latest.status) === '已归档') {
      errors.push(`${label}：测点 ${row.point}（${direction}）已归档，归档记录不能被回传文件覆盖`)
      continue
    }
    // 重复上传判定：同一测点+方向+基准累积量已有回传记录
    const duplicated = latestRecordByBaseline(tiltRows, row.point, direction, row.baseline)
    if (duplicated) {
      const status = String(duplicated.status)
      if (status === '已校核' || status === '已归档') {
        errors.push(
          `${label}：测点 ${row.point}（${direction}）该基准的回传记录状态为「${status}」，保留已校核版本，拒绝文件覆盖`,
        )
        continue
      }
      // 未校核：以最新原始记录为准，原位覆盖
      plans.push({ kind: 'replace', row: checked, direction, latest, target: duplicated })
      continue
    }
    const currentBaseline = latest ? (toNumber(latest['累积倾斜量']) ?? 0) : 0
    if (!nearlyEqual(row.baseline, currentBaseline)) {
      errors.push(
        `${label}：上次累积量 ${row.baseline} 与平台最新累积量 ${currentBaseline} 不一致，采集文件已过期，请重新下载`,
      )
      continue
    }
    plans.push({ kind: 'insert', row: checked, direction, latest, target: null })
  }

  if (errors.length > 0) {
    return failed(`逐条校验未通过 ${errors.length} 处，整包已退回，未写入任何记录`, errors)
  }

  // 整包落盘：倾斜记录与校时任务拼成一份快照一次提交
  const batch = batchNo()
  const nextTilt = [...tiltRows]
  let nextId = nextTilt.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let created = 0
  let replaced = 0
  const touchedPoints = new Set<string>()

  for (const plan of plans) {
    const baseAngle =
      plan.kind === 'replace'
        ? (toNumber(plan.target?.['基准角度']) ?? plan.row.angle)
        : plan.latest
          ? (toNumber(plan.latest['倾斜角度']) ?? plan.row.angle)
          : plan.row.angle
    const change = round4(plan.row.angle - baseAngle)
    const cumulative = round4(plan.row.baseline + change)
    touchedPoints.add(plan.row.point)
    if (plan.kind === 'replace' && plan.target) {
      const index = nextTilt.findIndex((row) => Number(row.id) === Number(plan.target?.id))
      nextTilt[index] = {
        ...nextTilt[index],
        观测方向: plan.direction,
        倾斜角度: plan.row.angle,
        变化量: change,
        累积倾斜量: cumulative,
        观测人: plan.row.observer,
        记录状态: '待校核',
        基准累积量: plan.row.baseline,
        基准角度: baseAngle,
        回传批次: batch,
        status: '待校核',
        pending: true,
        abnormal: false,
      }
      replaced += 1
    } else {
      nextTilt.push({
        id: nextId,
        status: '待校核',
        pending: true,
        abnormal: false,
        记录编号: `TILT-${String(nextId).padStart(4, '0')}`,
        测点编号: plan.row.point,
        观测方向: plan.direction,
        倾斜角度: plan.row.angle,
        变化量: change,
        累积倾斜量: cumulative,
        观测人: plan.row.observer,
        记录状态: '待校核',
        基准累积量: plan.row.baseline,
        基准角度: baseAngle,
        回传批次: batch,
      })
      nextId += 1
      created += 1
    }
  }

  // 回传成功：为每个涉及到的测点生成传感器校时任务（已有待校时任务的测点不重复生成）
  const nextTasks = [...listRows(TIMECAL_KEY)]
  let taskId = nextTasks.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let tasks = 0
  for (const point of touchedPoints) {
    const hasOpen = nextTasks.some(
      (task) => String(task['测点编号']) === point && String(task.status) === '待校时',
    )
    if (hasOpen) {
      continue
    }
    nextTasks.push({
      id: taskId,
      status: '待校时',
      pending: true,
      abnormal: false,
      任务编号: `CALI-${String(taskId).padStart(4, '0')}`,
      测点编号: point,
      任务来源: '倾斜外业回传',
      回传批次: batch,
      创建时间: nowText(),
    })
    taskId += 1
    tasks += 1
  }

  commitAll({ ...allRows(), [TILT_KEY]: nextTilt, [TIMECAL_KEY]: nextTasks })
  return {
    ok: true,
    message: `回传成功：新增 ${created} 条、以最新原始记录覆盖未校核 ${replaced} 条，记录已进入待校核；监测设备页新增 ${tasks} 项传感器校时任务`,
    errors: [],
    created,
    replaced,
    tasks,
  }
}

function latestRecordByBaseline(
  rows: EntryRow[],
  point: string,
  direction: string,
  baseline: number,
): EntryRow | null {
  let found: EntryRow | null = null
  for (const row of rows) {
    if (String(row['测点编号'] ?? '').trim() !== point || directionOf(row) !== direction) {
      continue
    }
    const stored = toNumber(row['基准累积量'])
    if (stored === null || !nearlyEqual(stored, baseline)) {
      continue
    }
    if (!found || Number(row.id) > Number(found.id)) {
      found = row
    }
  }
  return found
}

/** 监测设备页的传感器校时任务列表，最新在前。 */
export function listTimecalTasks(): EntryRow[] {
  return [...listRows(TIMECAL_KEY)].sort((a, b) => Number(b.id) - Number(a.id))
}

export function completeTimecalTask(id: number): ActionResult {
  const tasks = listRows(TIMECAL_KEY)
  const index = tasks.findIndex((task) => Number(task.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的校时任务` }
  }
  if (String(tasks[index].status) === '已校时') {
    return { ok: false, message: '该任务已完成校时，不用重复操作' }
  }
  const next = [...tasks]
  next[index] = { ...tasks[index], status: '已校时', pending: false }
  saveRows(TIMECAL_KEY, next)
  return { ok: true, message: `校时任务 ${String(tasks[index]['任务编号'])} 已完成` }
}
