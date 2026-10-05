<template>
  <section class="page" data-module="tilt">
    <header class="page-head">
      <div>
        <h2>倾斜监测管理</h2>
        <p class="page-desc">维护倾斜记录，围绕记录编号、测点编号、观测方向、倾斜角度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记倾斜记录</button>
        <button class="btn" type="button" @click="exportRows">导出倾斜监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="return-pack">
      <h3>外业回传包</h3>
      <p class="pack-note">
        勾选测点后下载采集文件（含坐标系、观测方向、上次累积量），现场补录倾斜角度与观测人后上传。
        平台逐条校验，整包一次写入或全部退回；同一测点重复上传时保留已校核版本、未校核记录以最新原始记录为准；
        已归档记录不能被文件覆盖；缺失观测方向的旧数据按「未标注」处理。回传成功后监测设备页会新增传感器校时任务。
      </p>
      <div class="pack-points">
        <label
          v-for="point in pointOptions"
          :key="point.key"
          class="pack-point"
          :class="{ disabled: point.archived }"
        >
          <input
            v-model="selectedPoints"
            type="checkbox"
            :value="point.key"
            :disabled="point.archived"
          />
          {{ point.point }} · {{ point.direction }}（上次累积 {{ point.baseline }}）
          <template v-if="point.archived">· 已归档</template>
        </label>
        <span v-if="!pointOptions.length" class="empty-state">暂无测点，请先登记倾斜记录</span>
      </div>
      <div class="pack-actions">
        <button class="btn" type="button" @click="downloadPack">下载采集文件</button>
        <label class="btn upload-btn">
          上传回传文件
          <input type="file" accept=".csv,text/csv" hidden @change="uploadPack" />
        </label>
      </div>
      <p v-if="packMessage" class="pack-message" :class="{ error: !packOk }">{{ packMessage }}</p>
      <ul v-if="packErrors.length" class="pack-errors">
        <li v-for="error in packErrors" :key="error">{{ error }}</li>
      </ul>
    </section>

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
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
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
  downloadCollectionFile,
  listTiltPoints,
  uploadCollectionFile,
  UNMARKED_DIRECTION,
} from '@/api/field-return'
import type { TiltPointOption } from '@/api/field-return'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('tilt')
const columns = ["记录编号", "测点编号", "观测方向", "倾斜角度", "变化量", "累积倾斜量", "观测人", "记录状态"]
const actions = ["提交校核", "确认校核", "触发报警", "归档记录"]
const statuses = ["已观测", "待校核", "已校核", "超限报警", "需复测", "已归档"]
const stats = [{"label": "本月观测数", "value": 0}, {"label": "超限报警数", "value": 0}, {"label": "待校核数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const pointOptions = ref<TiltPointOption[]>([])
const selectedPoints = ref<string[]>([])
const packMessage = ref('')
const packErrors = ref<string[]>([])
const packOk = ref(true)

// 缺失观测方向的旧数据在表格里也按「未标注」展示
function displayCell(row: EntryRow, column: string): string | number {
  const value = row[column]
  if (column === '观测方向' && String(value ?? '').trim() === '') {
    return UNMARKED_DIRECTION
  }
  return (value ?? '—') as string | number
}

function refreshPoints() {
  pointOptions.value = listTiltPoints()
}

function downloadPack() {
  packErrors.value = []
  if (!selectedPoints.value.length) {
    packOk.value = false
    packMessage.value = '请先勾选要下载采集文件的测点'
    return
  }
  const filename = downloadCollectionFile(selectedPoints.value)
  packOk.value = true
  packMessage.value = `已下载 ${filename}，请现场补录倾斜角度与观测人后再上传`
}

async function uploadPack(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const content = await file.text()
  const result = uploadCollectionFile(content)
  packOk.value = result.ok
  packMessage.value = result.message
  packErrors.value = result.errors
  input.value = ''
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
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
    refreshPoints()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '倾斜监测列表读取失败'
  }
}

onMounted(reload)
</script>
