import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.js'
import './appearance.js'

createRoot(document.getElementById('root')).render(h(App))
