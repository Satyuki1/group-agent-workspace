import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../app/ui/src/appearance.js'
import { TeamApp } from './app.tsx'
import './style.css'

createRoot(document.getElementById('root')!).render(<TeamApp />)
