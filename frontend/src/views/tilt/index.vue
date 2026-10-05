<template>
  <section class="page" data-module="tilt">
    <header class="page-head">
      <div>
        <h2>倾斜监测管理</h2>
        <p class="page-desc">
          维护倾斜记录，围绕记录编号、测点编号、观测方向、倾斜角度做登记、筛选与状态流转；
          支持选择测点下载带坐标系、观测方向与上次累积量的外业采集文件，补录后回传逐行校验。
          缺失观测方向的旧数据按「未标注」兼容；重复上传时已校核、已归档版本保留，未校核记录以最新原始记录覆盖后继续校核。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记倾斜记录</button>
        <button class="btn" type="button" @click="exportRows">导出倾斜监测清单</button>
      </div>
    </header>

    <section class="backhaul-panel">
      <h3 class="panel-title">外业回传包</h3>
      <ol class="rule-list">
        <li>选择测点后下载采集文件，文件内含测点坐标系、各观测方向及上次累积倾斜量。</li>
        <li>现场逐行补录观测日期与倾斜角度（变化量、累积量留空将自动推算）后上传。</li>
        <li>平台逐行校验：任一数据行不合格或试图覆盖已归档记录，整包退回、一条不写入。</li>
        <li>校验通过后整包一次写入；回传成功后自动在监测设备页生成该测点传感器校时任务。</li>
      </ol>
      <div class="backhaul-controls">
        <label class="filter-item">
          <span>选择测点</span>
          <select v-model="selectedPoint">
            <option value="" disabled>请选择测点</option>
            <option v-for="point in points" :key="point.pointId" :value="point.pointId">
              {{ point.pointId }}（{{ point.crs }}，{{ point.directions.length }} 个方向）
            </option>
          </select>
        </label>
        <button class="btn" type="button" :disabled="!selectedPoint" @click="downloadPackage">
          下载外业采集文件
        </button>
        <span class="upload-hint">
          <label class="btn primary upload-btn">
            上传补录后的回传包
            <input
              ref="fileInput"
              type="file"
              accept=".csv,text/csv"
              hidden
              @change="onFilePicked"
          </label>
          <span class="upload-name">{{ pickedFileName || '未选择文件' }}</span>
        </span>
      </div>

      <div v-if="backhaulResult" class="backhaul-result" :class="backhaulResult.ok ? 'is-ok' : 'is-fail'">
        <header class="result-head">
          <strong>{{ backhaulResult.ok ? '回传成功，整包已写入' : '整包退回，未写入任何记录' }}</strong>
          <span v-if="backhaulResult.pointId">测点：{{ backhaulResult.pointId }}（{{ backhaulResult.crs }}）</span>
        </header>
        <p v-if="backhaulResult.ok" class="result-summary">
          新增 {{ backhaulResult.inserted }} 条 · 覆盖原始 {{ backhaulResult.replaced }} 条（均待校核）·
          保留已校核 {{ backhaulResult.kept }} 条 · 忽略空模板行 {{ backhaulResult.ignored }} 条
        </p>
        <ul v-if="backhaulResult.syncTask" class="sync-task" :class="{ muted: !backhaulResult.syncTask.created }">
          <li>{{ backhaulResult.syncTask.message }}</li>
          <li v-if="backhaulResult.syncTask.created">
            <RouterLink class="link" to="/device">前往监测设备页完成校时 →</RouterLink>
          </li>
        </ul>
        <ul v-if="backhaulResult.errors.length" class="error-list">
          <li v-for="(error, index) in backhaulResult.errors" :key="index" class="error-text">{{ error }}</li>
        </ul>
        <table v-if="backhaulResult.checks.length" class="check-table">
          <thead>
            <tr>
              <th>文件行</th>
              <th>测点编号</th>
              <th>观测日期</th>
              <th>观测方向</th>
              <th>处理结论</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="check in backhaulResult.checks" :key="check.line" :class="{ 'row-fail': !check.ok }">
              <td>{{ check.line }}</td>
              <td>{{ check.pointId || '—' }}</td>
              <td>{{ check.date || '—' }}</td>
              <td>{{ check.direction || '—' }}</td>
              <td>{{ check.action }}</td>
              <td>{{ check.message }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无倾斜监测数据，可先登记倾斜记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条倾斜监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadBackhaulPackage,
  listPoints,
  submitBackhaul,
  type BackhaulResult,
  type PointSummary,
  UNLABELED_DIRECTION,
} from '@/api/tilt-backhaul'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('tilt')
const columns = ["记录编号", "测点编号", "观测日期", "坐标系", "观测方向", "倾斜角度", "变化量", "累积倾斜量", "观测人", "记录状态"]
const actions = ["提交校核", "确认校核", "触发报警", "归档记录"]
const statuses = ["已观测", "待校核", "已校核", "超限报警", "需复测", "已归档"]
const stats = computed(() => {
  const monthPrefix = new Date().toISOString().slice(0, 7)
  return [
    { label: "本月观测数", value: rows.value.filter((row) => String(row['观测日期'] ?? '').startsWith(monthPrefix)).length },
    { label: "超限报警数", value: rows.value.filter((row) => String(row.status) === '超限报警').length },
    { label: "待校核数", value: rows.value.filter((row) => String(row.status) === '待校核').length },
  ]
})

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "测点编号", "观测方向"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const points = ref<PointSummary[]>([])
const selectedPoint = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const pickedFileName = ref('')
const backhaulResult = ref<BackhaulResult | null>(null)

function formatCell(row: EntryRow, column: string): string | number | boolean {
  const value = row[column]
  // 缺失观测方向的旧数据按「未标注」兼容展示。
  if (column === '观测方向' && (value === undefined || value === null || String(value).trim() === '')) {
    return UNLABELED_DIRECTION
  }
  return value ?? '—'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function downloadPackage() {
  errorMessage.value = ''
  if (!selectedPoint.value) {
    return
  }
  downloadBackhaulPackage(selectedPoint.value)
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  errorMessage.value = ''
  pickedFileName.value = file.name
  try {
    const text = await file.text()
    backhaulResult.value = submitBackhaul(file.name, text)
    reload()
  } catch (error) {
    backhaulResult.value = null
    errorMessage.value = error instanceof Error ? error.message : '回传包读取失败'
  } finally {
    input.value = ''
  }
}

function openCreate() {
  errorMessage.value = '倾斜记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    points.value = listPoints()
    if (selectedPoint.value && !points.value.some((point) => point.pointId === selectedPoint.value)) {
      selectedPoint.value = ''
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '倾斜监测列表读取失败'
  }
}

onMounted(reload)
</script>
