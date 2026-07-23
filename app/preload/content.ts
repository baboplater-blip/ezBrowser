import { contextBridge } from 'electron'
import './external-features'

const api = {
  version: '0.1.0',
}

contextBridge.exposeInMainWorld('browserBuild', api)

export type ContentAPI = typeof api
