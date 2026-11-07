export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// percent: 컨텍스트 사용률(화면에는 안 보이고, /compact·/clear 를 권할지 판단하는 데만 쓴다)
export type Usage = { percent: number | null; limits: Limit[] }

/** 컨텍스트를 차지하는 항목 하나(이름은 한글로 바꾼 것, tokens 는 추정치) */
export type Row = { label: string; tokens: number }

/** 사용처: 항목별 토큰과, 그 비율을 계산할 기준 창 크기 */
export type Breakdown = { rows: Row[]; window: number }

/** 큰 작업 하나(지금은 큰 파일 읽기) */
export type BigItem = { what: string; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'token-gauge': {
      usage: Usage
      /** 로그 줄이기로 아낀 토큰 추정치(글자 수 / 4) */
      savedTokens: number
      /** 로그 줄이기 기능 켬/끔 */
      isReducerOn: boolean
      /** 펼쳐진 기능 캡슐 id. null 은 자동, 'none' 은 사용자가 직접 접어 둔 상태 */
      openGroup: string | null
      /** 마지막으로 응답이 오간 시각(ms). 캐시 유지 시간 계산용 */
      lastActive: number | null
      /** 지금 Claude 가 작업 중인지 */
      isRunning: boolean
      /** 30초마다 갱신되는 현재 시각(ms). 화면이 시간 흐름을 따라가게 한다 */
      now: number
      /** 사용처 측정 결과. 아직 없으면 null */
      breakdown: Breakdown | null
      /** 지금까지 지나간 큰 파일 읽기 */
      bigItems: BigItem[]
      /** 돌고 있는 반복 작업 id ('wake' 는 /loop 자동 간격) */
      loopIds: string[]
      /** 이번 세션에서 띄운 보조 AI 횟수 */
      agentCount: number
    }
  }
}
