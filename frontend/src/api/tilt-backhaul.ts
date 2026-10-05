import { allRows, commitAll } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

/**
 * 倾斜监测「外业回传包」服务（纯前端实现，接口形态对齐后端包上传接口）。
 *
 * 回传包是带元信息头的 CSV：前若干行以 # 开头，写明测点、坐标系、下载时间与
 * 各观测方向的上次累积量；空行之后是逐行补录的观测数据表，现场只填日期/角度等。
 *
 * 约定：
 * - 重复上传：已校核、已归档的既有记录保留平台版本（归档行整包硬拦截退回，
 *   校核行跳过覆盖）；未校核记录以最新原始记录覆盖并打回「待校核」继续校核。
 * - 缺失方向的旧数据按「未标注」兼容：空方向归一化为「未标注」后再展示与匹配。
 * - 整包写入：先逐行校验（含校时任务预演），任一行失败则一条都不落库；
 *   全部通过后在一次 localStorage 事务里写入倾斜记录并创建传感器校时任务。
 */

export const UNLABELED_DIRECTION = '未标注'
export const DEFAULT_CRS = 'CGCS2000'
const TILT_KEY = 'tilt'
const DEVICE_KEY = 'device'
const PACKAGE_MARK = '倾斜监测外业回传包'

// 允许使用的坐标系：包元信息与数据行都必须落在这个清单里。
const ALLOWED_CRS = ['CGCS2000', 'WGS84', '北京54', '西安80']

const CSV_HEADER = [
  '记录编号',
  '测点编号',
  '观测日期',
  '坐标系',
  '观测方向',
  '倾斜角度',
  '变化量',
  '累积倾斜量',
  '观测人',
]

export type PointSummary = {
  pointId: string
  crs: string
  directions: { direction: string; lastCumulative: string }[]
}

export type RowCheck = {
  line: number
  pointId: string
  date: string
  direction: string
  ok: boolean
  action: '新增' | '覆盖原始' | '保留已校核' | string
  message: string
}

export type BackhaulResult = {
  ok: boolean
  pointId: string
  crs: string
  inserted: number
  replaced: number
  kept: number
  ignored: number
  syncTask?: { created: boolean; deviceNo: string; message: string }
  errors: string[]
  checks: RowCheck[]
}

function tiltRows(): EntryRow[] {
  return allRows()[TILT_KEY] ?? []
}

function normDirection(value: unknown): string {
  return String(value ?? '').trim() === '' ? UNLABELED_DIRECTION : String(value).trim()
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const text = String(value ?? '').trim()
  if (text === '') {
    return null
  }
  const matched = text.match(/-?\d+(?:\.\d+)?/)
  if (!matched) {
    return null
  }
  const num = Number(matched[0])
  return Number.isFinite(num) ? num : null
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function timestampText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`
}

/** 供页面选择测点：按测点编号聚合，带坐标系与各方向上次累积量。 */
export function listPoints(): PointSummary[] {
  const grouped = new Map<string, EntryRow[]>()
  for (const row of tiltRows()) {
    const pointId = String(row['测点编号'] ?? '').trim()
    if (!pointId) {
      continue
    }
    grouped.set(pointId, [...(grouped.get(pointId) ?? []), row])
  }
  return [...grouped.entries()].map(([pointId, rows]) => {
    const crs = String(rows[0]['坐标系'] ?? '').trim() || DEFAULT_CRS
    const byDirection = new Map<string, EntryRow>()
    for (const row of rows) {
      const direction = normDirection(row['观测方向'])
      const current = byDirection.get(direction)
      if (!current || isLater(row, current)) {
        byDirection.set(direction, row)
      }
    }
    return {
      pointId,
      crs,
      directions: [...byDirection.values()].map((row) => ({
        direction: normDirection(row['观测方向']),
        lastCumulative: String(row['累积倾斜量'] ?? '').trim(),
      })),
    }
  })
}

function isLater(row: EntryRow, other: EntryRow): boolean {
  const date = String(row['观测日期'] ?? '')
  const otherDate = String(other['观测日期'] ?? '')
  if (date !== otherDate) {
    return date > otherDate
  }
  return Number(row.id) > Number(other.id)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 生成并下载某测点的外业采集文件：带坐标系、观测方向与上次累积量。 */
export function buildBackhaulPackage(pointIdInput: string): { filename: string; content: string } {
  const pointId = pointIdInput.trim()
  const point = listPoints().find((item) => item.pointId === pointId)
  if (!point) {
    throw new Error(`平台上没有测点「${pointId}」，请先选择有效测点`)
  }

  const lines: string[] = [
    `# ${PACKAGE_MARK}`,
    `# 测点编号: ${point.pointId}`,
    `# 坐标系: ${point.crs}`,
    `# 下载时间: ${timestampText()}`,
  ]
  if (point.directions.length === 0) {
    lines.push('# 上次累积量: 该测点暂无历史观测，按首次观测处理')
  } else {
    for (const item of point.directions) {
      lines.push(`# 上次累积量(方向 ${item.direction}): ${item.lastCumulative || '0'}`)
    }
  }
  lines.push('# 填写说明: 逐行补录观测日期与倾斜角度；变化量、累积倾斜量留空将按上次累积量自动推算；观测人留空记为「外业补录」；新增行记录编号留空。')
  lines.push('')
  lines.push(CSV_HEADER.map(csvCell).join(','))
  for (const item of point.directions) {
    lines.push(
      ['', point.pointId, '', '', item.direction === UNLABELED_DIRECTION ? '' : item.direction, '', '', '', '']
        .map(csvCell)
        .join(','),
    )
  }

  return {
    filename: `倾斜外业回传包-${point.pointId}-${todayText()}.csv`,
    content: `﻿${lines.join('\r\n')}`,
  }
}

export function downloadBackhaulPackage(pointId: string): void {
  const { filename, content } = buildBackhaulPackage(pointId)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

type ParsedCell = { raw: string; value: string }

/** 解析一行 CSV，支持双引号包裹、引号转义与逗号。 */
function parseCsvLine(line: string): ParsedCell[] {
  const cells: ParsedCell[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push({ raw: field, value: field.trim() })
      field = ''
    } else {
      field += char
    }
  }
  cells.push({ raw: field, value: field.trim() })
  return cells
}

function isValidDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }
  const date = new Date(`${text}T00:00:00`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

const ARCHIVED_STATUS = '已归档'
const VERIFIED_STATUS = '已校核'

/**
 * 解析并校验整包，全部通过才一次落库：
 * 任一行存在错误（含试图覆盖已归档记录、坐标系不符、测点不在平台等）即整包退回，
 * 已校核版本始终保留，未校核版本以最新原始记录覆盖后继续走校核。
 */
export function submitBackhaul(filename: string, text: string): BackhaulResult {
  const result: BackhaulResult = {
    ok: false,
    pointId: '',
    crs: DEFAULT_CRS,
    inserted: 0,
    replaced: 0,
    kept: 0,
    ignored: 0,
    errors: [],
    checks: [],
  }

  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  const meta = new Map<string, string>()
  let headerLineNumber = 0
  let headerCells: ParsedCell[] = []
  let dataStartLine = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    if (trimmed.startsWith('#')) {
      const body = trimmed.slice(1).trim()
      const splitAt = body.search(/[:：]/)
      if (splitAt > 0) {
        meta.set(body.slice(0, splitAt).trim(), body.slice(splitAt + 1).trim())
      }
      continue
    }
    const cells = parseCsvLine(line)
    if (cells.length >= 3 && cells[0].value === CSV_HEADER[0] && cells[1].value === CSV_HEADER[1]) {
      headerLineNumber = index + 1
      headerCells = cells
      dataStartLine = index + 1
    }
    break
  }

  if (headerLineNumber === 0) {
    if (![...meta.keys()].some((key) => key.includes('外业回传包'))) {
      result.errors.push('文件不是倾斜监测外业回传包，请先在页面选择测点下载采集文件后再上传')
      return result
    }
    result.errors.push('缺少数据表头，请使用下载的采集文件原样补录后上传')
    return result
  }

  const expectedPoint = (meta.get('测点编号') ?? '').trim()
  const packageCrs = (meta.get('坐标系') ?? '').trim() || DEFAULT_CRS
  result.pointId = expectedPoint
  result.crs = packageCrs

  if (!ALLOWED_CRS.includes(packageCrs)) {
    result.errors.push(`包头坐标系「${packageCrs}」不在允许清单（${ALLOWED_CRS.join('、')}）`)
  }

  // 表头列序必须与下载模板一致，避免现场挪动列后错列写入。
  const headerMismatch = CSV_HEADER.find((name, index) => headerCells[index]?.value !== name)
  if (headerMismatch) {
    result.errors.push(`数据表头与模板不一致，请保留模板列序（第 ${headerLineNumber} 行）`)
    return result
  }

  const existingRows = tiltRows()
  const platformPointIds = new Set(
    existingRows.map((row) => String(row['测点编号'] ?? '').trim()).filter(Boolean),
  )
  if (!platformPointIds.has(expectedPoint)) {
    result.errors.push(`测点「${expectedPoint}」在平台上不存在，无法回传`)
  }

  const byRecordNo = new Map<string, EntryRow>()
  const byDateDirection = new Map<string, EntryRow>()
  for (const row of existingRows) {
    const recordNo = String(row['记录编号'] ?? '').trim()
    if (recordNo) {
      byRecordNo.set(recordNo, row)
    }
    byDateDirection.set(
      `${String(row['测点编号'] ?? '').trim()}|${String(row['观测日期'] ?? '').trim()}|${normDirection(
        row['观测方向'],
      )}`,
      row,
    )
  }

  // 上次累积量与上次角度（按方向）：取该测点每方向最新一条历史记录作为推算基线。
  const baseline = new Map<string, { cumulative: number | null; angle: number | null }>()
  const baselineRow = new Map<string, EntryRow>()
  for (const row of existingRows) {
    if (String(row['测点编号'] ?? '').trim() !== expectedPoint) {
      continue
    }
    const direction = normDirection(row['观测方向'])
    const current = baselineRow.get(direction)
    if (!current || isLater(row, current)) {
      baselineRow.set(direction, row)
      baseline.set(direction, {
        cumulative: parseNumber(row['累积倾斜量']),
        angle: parseNumber(row['倾斜角度']),
      })
    }
  }

  const seenRecordNo = new Set<string>()
  const seenDateDirection = new Set<string>()

  type Planned =
    | { kind: 'insert'; line: number; fields: Record<string, string | number>; pointId: string; date: string; direction: string }
    | { kind: 'replace'; line: number; target: EntryRow; fields: Record<string, string | number>; pointId: string; date: string; direction: string }
  const planned: Planned[] = []

  for (let index = dataStartLine; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      continue
    }
    const lineNo = index + 1
    const cells = parseCsvLine(line)
    const get = (fieldIndex: number): string => cells[fieldIndex]?.value ?? ''

    const recordNo = get(0)
    const pointId = get(1)
    const date = get(2)
    const rowCrs = get(3) || packageCrs
    const direction = normDirection(get(4))
    const angleText = get(5)
    const changeText = get(6)
    const cumulativeText = get(7)
    const observer = get(8)

    // 模板预填行：日期与数值都没填，视为现场未补录，跳过不校验。
    const isBlankTemplate = date === '' && angleText === '' && changeText === '' && cumulativeText === ''
    if (isBlankTemplate) {
      result.ignored += 1
      result.checks.push({
        line: lineNo,
        pointId,
        date: '—',
        direction,
        ok: true,
        action: '跳过空模板行',
        message: '未补录，已忽略',
      })
      continue
    }

    const rowErrors: string[] = []
    if (pointId === '') {
      rowErrors.push('测点编号缺失')
    } else if (expectedPoint && pointId !== expectedPoint) {
      rowErrors.push(`测点编号「${pointId}」与包头测点「${expectedPoint}」不一致`)
    } else if (!platformPointIds.has(pointId)) {
      rowErrors.push(`测点「${pointId}」在平台上不存在`)
    }

    if (!isValidDate(date)) {
      rowErrors.push('观测日期需为 YYYY-MM-DD 格式的有效日期')
    } else if (date > todayText()) {
      rowErrors.push('观测日期不能晚于今天')
    }

    if (rowCrs && !ALLOWED_CRS.includes(rowCrs)) {
      rowErrors.push(`坐标系「${rowCrs}」不在允许清单`)
    } else if (rowCrs && packageCrs && rowCrs !== packageCrs) {
      rowErrors.push(`行坐标系「${rowCrs}」与包头坐标系「${packageCrs}」不一致`)
    }

    const angle = parseNumber(angleText)
    if (angleText === '') {
      rowErrors.push('倾斜角度必填')
    } else if (angle === null) {
      rowErrors.push(`倾斜角度「${angleText}」不是数值`)
    } else if (angle < 0) {
      rowErrors.push('倾斜角度不能为负')
    }

    const change = changeText === '' ? null : parseNumber(changeText)
    if (changeText !== '' && change === null) {
      rowErrors.push(`变化量「${changeText}」不是数值`)
    }
    const cumulativeGiven = cumulativeText === '' ? null : parseNumber(cumulativeText)
    if (cumulativeText !== '' && cumulativeGiven === null) {
      rowErrors.push(`累积倾斜量「${cumulativeText}」不是数值`)
    }

    if (recordNo && seenRecordNo.has(recordNo)) {
      rowErrors.push(`记录编号「${recordNo}」在包内重复`)
    }
    const dateDirectionKey = `${date}|${direction}`
    if (date && seenDateDirection.has(dateDirectionKey)) {
      rowErrors.push(`同一测点在 ${date} 的「${direction}」方向在包内重复`)
    }

    if (rowErrors.length > 0) {
      result.checks.push({
        line: lineNo,
        pointId,
        date,
        direction,
        ok: false,
        action: '校验失败',
        message: rowErrors.join('；'),
      })
      result.errors.push(`第 ${lineNo} 行：${rowErrors.join('；')}`)
      continue
    }

    seenRecordNo.add(recordNo)
    seenDateDirection.add(dateDirectionKey)

    const matched = (recordNo ? byRecordNo.get(recordNo) : undefined) ?? byDateDirection.get(`${pointId}|${date}|${direction}`)
    if (matched && String(matched['测点编号'] ?? '').trim() !== pointId) {
      // 编号碰巧撞上别的测点，按同测点重复规则直接拦下。
      result.errors.push(`第 ${lineNo} 行：记录编号「${recordNo}」属于其他测点`)
      result.checks.push({
        line: lineNo,
        pointId,
        date,
        direction,
        ok: false,
        action: '校验失败',
        message: '记录编号属于其他测点',
      })
      continue
    }

    if (matched && String(matched.status) === ARCHIVED_STATUS) {
      // 已归档记录不能再被文件覆盖：命中即整包退回。
      const message = `已归档记录（${String(matched['记录编号'] ?? '')}）不能被回传文件覆盖`
      result.errors.push(`第 ${lineNo} 行：${message}`)
      result.checks.push({
        line: lineNo,
        pointId,
        date,
        direction,
        ok: false,
        action: '拒绝覆盖归档',
        message,
      })
      continue
    }

    if (matched && String(matched.status) === VERIFIED_STATUS) {
      // 重复上传策略：已校核版本保留，不覆盖。
      result.kept += 1
      result.checks.push({
        line: lineNo,
        pointId,
        date,
        direction,
        ok: true,
        action: '保留已校核',
        message: `已校核记录（${String(matched['记录编号'] ?? '')}）保留平台版本，不覆盖`,
      })
      continue
    }

    // 累积量推算：优先取现场填写值，否则 上次累积 + 本次变化；都没有则以本次角度兜底。
    const base = baseline.get(direction)
    let cumulative = cumulativeGiven
    if (cumulative === null) {
      if (change !== null && base?.cumulative !== null && base?.cumulative !== undefined) {
        cumulative = round3(base.cumulative + change)
      } else {
        cumulative = angle as number
      }
    }

    const fields: Record<string, string | number> = {
      测点编号: pointId,
      观测日期: date,
      坐标系: rowCrs,
      观测方向: direction,
      倾斜角度: angle as number,
      变化量: change ?? (base?.angle !== null && base?.angle !== undefined ? round3((angle as number) - base.angle) : 0),
      累积倾斜量: cumulative,
      观测人: observer || '外业补录',
      记录状态: '待校核',
    }

    if (matched) {
      result.replaced += 1
      result.checks.push({
        line: lineNo,
        pointId,
        date,
        direction,
        ok: true,
        action: '覆盖原始',
        message: `以最新原始记录覆盖（${String(matched['记录编号'] ?? '')}），打回待校核继续校核`,
      })
      planned.push({ kind: 'replace', line: lineNo, target: matched, fields, pointId, date, direction })
    } else {
      result.inserted += 1
      result.checks.push({
        line: lineNo,
        pointId,
        date,
        direction,
        ok: true,
        action: '新增',
        message: '新增原始记录，状态置为待校核',
      })
      planned.push({ kind: 'insert', line: lineNo, fields, pointId, date, direction })
    }

    // 本行进包后即成为该方向最新基线，供后续行推算。
    baseline.set(direction, { cumulative, angle: angle as number })
  }

  if (result.errors.length > 0 || planned.length === 0) {
    if (result.errors.length === 0) {
      result.errors.push('回传包没有需要写入的补录行（仅含已校核记录或空模板行），整包未提交')
    }
    return result
  }

  // ---- 整包预演通过，以下在一次事务内提交，失败不产生半成品 ----
  const nextTilt = [...tiltRows()]
  let nextId = nextTilt.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  for (const item of planned) {
    if (item.kind === 'replace') {
      const index = nextTilt.indexOf(item.target)
      if (index < 0) {
        result.errors.push(`第 ${item.line} 行：目标记录在提交时已不存在，整包退回`)
        return result
      }
      nextTilt[index] = {
        ...item.target,
        ...item.fields,
        status: '待校核',
        pending: true,
        abnormal: false,
      }
    } else {
      nextId += 1
      nextTilt.push({
        id: nextId,
        status: '待校核',
        pending: true,
        abnormal: false,
        记录编号: `TILT-${String(nextId).padStart(4, '0')}`,
        ...item.fields,
      })
    }
  }

  // 传感器校时任务：同测点已有待校时任务则复用，不重复下发。
  const devices = [...(allRows()[DEVICE_KEY] ?? [])]
  const openTask = devices.find(
    (row) =>
      row['任务类型'] === '传感器校时' &&
      String(row['关联测点'] ?? '').trim() === expectedPoint &&
      String(row.status) === '待校时',
  )
  let nextDevices = devices
  if (openTask) {
    result.syncTask = {
      created: false,
      deviceNo: String(openTask['设备编号'] ?? ''),
      message: `该测点已有待办校时任务（${String(openTask['设备编号'] ?? '')}），本次复用，不重复下发`,
    }
  } else {
    const deviceId = devices.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const deviceNo = `SYNC-${String(deviceId).padStart(4, '0')}`
    const task: EntryRow = {
      id: deviceId,
      status: '待校时',
      pending: true,
      abnormal: false,
      设备编号: deviceNo,
      设备类型: '倾斜传感器',
      所属隐患点: '',
      安装日期: todayText(),
      最近维护日: '',
      电池余量: '',
      通讯状态: '',
      设备状态: '待校时',
      任务类型: '传感器校时',
      关联测点: expectedPoint,
    }
    nextDevices = [...devices, task]
    result.syncTask = {
      created: true,
      deviceNo,
      message: `已在监测设备页新增传感器校时任务（${deviceNo}），校时完成后状态回到正常运行`,
    }
  }

  try {
    commitAll({ [TILT_KEY]: nextTilt, [DEVICE_KEY]: nextDevices })
  } catch (error) {
    result.errors.push(
      `整包写入失败，已全部退回：${error instanceof Error ? error.message : '未知存储错误'}`,
    )
    return result
  }

  result.ok = true
  return result
}
