document.addEventListener('DOMContentLoaded', () => {
    const MODULES = [
        { id: 'input', title: 'Input', meters: ['L','R'], type: 'meter' },
        { id: 'agc', title: 'AGC', sub: 'Gate / Comp', meters: ['B','M','L','R'], type: 'comp', params: { thr: -20, ratio: 4, atk: 0.02, rel: 0.15, mkup: 6 } },
        { id: 'hf', title: 'HF Enhancer', meters: ['L','R'], type: 'meter' },
        { id: 'stereo', title: 'Stereo Enhancer', meters: ['L','R'], type: 'meter' },
        { id: 'gr', title: 'Gain Reduction', sub: 'Multi Gate', meters: ['1','2','3','4','5'], type: 'meter', narrow: true },
        { id: 'loudgr', title: 'Loudness GR', meters: ['L','R'], type: 'meter' },
        { id: 'limiter', title: 'Limiter', meters: ['L','R'], type: 'comp', params: { thr: -6, ratio: 20, atk: 0.001, rel: 0.08, mkup: 2 } },
        { id: 'basslim', title: 'Bass Limiter', meters: ['L','R'], type: 'comp', params: { thr: -12, ratio: 10, atk: 0.01, rel: 0.12, mkup: 4 } },
        { id: 'loudlevel', title: 'Loudness Level', meters: ['dB','LU'], type: 'lufs', tall: true },
        { id: 'output', title: 'Output', meters: ['L','R'], type: 'meter' }
    ];

    let audioCtx, currentStream;
    const stages = {}, channelStates = new Map(), peakState = {};
    const tooltip = document.getElementById('tooltip');
    const presets = JSON.parse(localStorage.getItem('broadcastProPresetsV5') || '{}');
    let activePreset = 'default', lufsEngine, renderId;
    const SEGMENTS = 50, PEAK_DECAY = 0.012;

    class IOManager {
        constructor() { this.inputSelect = null; this.outputSelect = null; this.statusEl = null; this.inputStatusEl = null; this.permitted = false; }
        init() {
            this.inputSelect = document.getElementById('inputDeviceSelect');
            this.outputSelect = document.getElementById('outputDeviceSelect');
            
            // Add input status indicator
            if(this.inputSelect && !this.inputSelect.previousElementSibling?.classList.contains('device-status')) {
                this.inputStatusEl = document.createElement('div');
                this.inputStatusEl.className = 'device-status';
                this.inputStatusEl.textContent = '⏳ Esperando dispositivos...';
                this.inputSelect.parentNode.insertBefore(this.inputStatusEl, this.inputSelect);
            }
            
            // Add output status indicator
            if(this.outputSelect && !this.outputSelect.nextElementSibling) {
                this.statusEl = document.createElement('div');
                this.statusEl.className = 'device-status';
                this.statusEl.textContent = '⏳ Inicia audio para activar';
                this.outputSelect.parentNode.appendChild(this.statusEl);
            }
            this._bindEvents();
        }
        async requestPermission() {
            if(this.permitted) return true;
            try { 
                const s = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false}}); 
                s.getTracks().forEach(t=>t.stop()); 
                this.permitted=true; 
                return true; 
            }
            catch(e) { 
                console.error('Permiso rechazado:', e);
                return false; 
            }
        }
        async refresh() {
            try {
                if(!await this.requestPermission()) { 
                    showToast('⚠️ Activa permisos de micrófono para ver dispositivos'); 
                    if(this.inputStatusEl) this.inputStatusEl.textContent = '❌ Sin permisos';
                    return; 
                }
                
                const devs = await navigator.mediaDevices.enumerateDevices();
                const inputs = devs.filter(d=>d.kind==='audioinput');
                const outputs = devs.filter(d=>d.kind==='audiooutput');
                
                this._populate(this.inputSelect, inputs, '🎛️ Seleccionar entrada...', 'Entrada');
                this._populate(this.outputSelect, outputs, '🔊 Default del Sistema', 'Salida');
                
                // Update input status
                if(this.inputStatusEl) {
                    if(inputs.length === 0) {
                        this.inputStatusEl.textContent = '❌ Sin entradas detectadas';
                        this.inputStatusEl.classList.remove('active');
                    } else {
                        this.inputStatusEl.textContent = `✅ ${inputs.length} entrada${inputs.length>1?'s':''} detectada${inputs.length>1?'s':''}`;
                        this.inputStatusEl.classList.add('active');
                    }
                }
                
                // Update output status
                if(this.statusEl) {
                    if(outputs.length === 0) {
                        this.statusEl.textContent = '❌ Sin salidas detectadas';
                        this.statusEl.classList.remove('active');
                    } else {
                        this.statusEl.textContent = `✅ ${outputs.length} salida${outputs.length>1?'s':''} detectada${outputs.length>1?'s':''}`;
                        this.statusEl.classList.add('active');
                    }
                }
                
                if(audioCtx?.sinkId && audioCtx.sinkId!=='default') this.outputSelect.value = audioCtx.sinkId;
            } catch(e) {
                console.error('Error en refresh:', e);
                showToast('⚠️ Error al enumerar dispositivos');
            }
        }
        _populate(select, devices, defaultText, labelPrefix) {
            if(!select) return;
            select.innerHTML = `<option value="">${defaultText}</option>`;
            devices.forEach((d, i) => { 
                const o = document.createElement('option'); 
                o.value = d.deviceId; 
                o.textContent = (d.label && d.label.trim()) ? d.label : `${labelPrefix} ${i+1}`; 
                select.appendChild(o); 
            });
            select.disabled = devices.length === 0;
        }
        async switchInput(deviceId) {
            if(!deviceId) return;
            try {
                if(currentStream) currentStream.getTracks().forEach(t=>t.stop());
                const constraints = {
                    audio: {
                        deviceId: { exact: deviceId },
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    }
                };
                currentStream = await navigator.mediaDevices.getUserMedia(constraints);
                await initAudioEngine(currentStream); 
                showToast('✅ Entrada conectada');
                if(this.inputStatusEl) {
                    this.inputStatusEl.textContent = `🟢 ${this.inputSelect.selectedOptions[0]?.textContent||'Entrada'}`;
                    this.inputStatusEl.classList.add('active');
                }
            } catch(e) { 
                showToast('❌ Error entrada: ' + e.message); 
                this.inputSelect.value = '';
                if(this.inputStatusEl) {
                    this.inputStatusEl.textContent = '❌ Error al conectar';
                    this.inputStatusEl.classList.remove('active');
                }
            }
        }
        async switchOutput(deviceId) {
            if(!audioCtx) return showToast('⚠️ Inicia audio primero');
            if(!audioCtx.setSinkId) return showToast('⚠️ Navegador no soporta cambio de salida');
            try {
                await audioCtx.setSinkId(deviceId || 'default');
                if(this.statusEl) { 
                    this.statusEl.textContent = `🟢 ${this.outputSelect.selectedOptions[0]?.textContent||'Default'}`; 
                    this.statusEl.classList.add('active'); 
                }
                showToast('✅ Salida conectada');
            } catch(e) { 
                showToast('❌ Error salida: ' + e.message); 
                this.outputSelect.value = '';
            }
        }
        _bindEvents() {
            this.inputSelect?.addEventListener('change', e => this.switchInput(e.target.value));
            this.outputSelect?.addEventListener('change', e => this.switchOutput(e.target.value));
            navigator.mediaDevices.addEventListener('devicechange', () => this.refresh());
        }
    }
    const ioManager = new IOManager();
    function showToast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 3000); }

    class LUFSEngine {
        constructor(ctx) { this.sr=ctx.sampleRate; this.frameSize=1024; this.momentaryLen=Math.ceil(this.sr*0.4/this.frameSize); this.shortTermLen=Math.ceil(this.sr*3.0/this.frameSize); this.energyBuf=new Float32Array(this.shortTermLen); this.idx=0; this.integratedSum=0; this.integratedCount=0; this.integrated=-70; }
        calculate(dL, dR) { const len=dL.length; let p=0; for(let i=0;i<len;i++) p+=dL[i]*dL[i]+dR[i]*dR[i]; p/=len; this.energyBuf[this.idx%this.energyBuf.length]=p; this.idx++; const avg=c=>{let s=0,st=Math.max(0,this.idx-c);for(let i=st;i<this.idx;i++)s+=this.energyBuf[i%this.energyBuf.length];return s/c;}; const toLU=pw=>pw>1e-20?-0.691+10*Math.log10(pw):-70; const m=toLU(avg(Math.min(this.momentaryLen,this.idx))), s=toLU(avg(Math.min(this.shortTermLen,this.idx))); if(m>-70){this.integratedSum+=p;this.integratedCount++;} this.integrated=this.integratedCount>0?toLU(this.integratedSum/this.integratedCount):-70; return {m,s,i:this.integrated}; }
        reset() { this.energyBuf.fill(0); this.idx=0; this.integratedSum=0; this.integratedCount=0; this.integrated=-70; }
    }

    function buildUI() {
        const grid=document.getElementById('grid'); grid.innerHTML='';
        MODULES.forEach(mod => {
            const el=document.createElement('div'); el.className='mod';
            let html=`<div class="mod-title">${mod.title}</div>`;
            if(mod.sub) html+=`<div class="mod-sub">${mod.sub}</div>`;
            html+=`<div class="meter-row">`;
            mod.meters.forEach((m,i)=>{const h=mod.tall?'tall':(mod.narrow?'narrow':''); html+=`<div class="meter-wrap"><div class="meter-box ${h}" data-mod="${mod.id}" data-ch="${i}" data-id="${mod.id}_${i}"><div class="leds">${'<div class="led"></div>'.repeat(50)}</div><div class="peak-line"></div></div><div class="meter-label">${m}</div></div>`;});
            html+=`</div><div class="controls-row">`;
            mod.meters.forEach((_,i)=>{html+=`<div class="ctrl"><div class="sm-btns"><button class="btn-s" data-mod="${mod.id}" data-ch="${i}">S</button><button class="btn-m" data-mod="${mod.id}" data-ch="${i}">M</button></div><div class="fader-track" data-mod="${mod.id}" data-ch="${i}" data-val="0"><div class="fader-fill" style="height:50%"></div><div class="fader-thumb" style="bottom:50%"></div></div><div class="ctrl-val">0.0 dB</div></div>`;});
            html+=`</div>`;
            if(mod.type==='comp' && mod.params) {
                html+=`<div class="controls-row" style="margin-top:4px; border-top:1px solid #222; padding-top:4px; width:100%">`;
                Object.entries(mod.params).forEach(([k,v])=>{html+=`<div class="ctrl"><label>${k.toUpperCase()}</label><input type="range" class="slider" min="${k==='thr'?-60:k==='ratio'?1:0}" max="${k==='thr'?0:k==='ratio'?20:k==='rel'?1:k==='mkup'?24:1}" step="0.1" value="${v}" data-mod="${mod.id}" data-param="${k}"><div class="ctrl-val" id="pv_${mod.id}_${k}">${v}</div></div>`;});
                html+=`</div>`;
            }
            if(mod.type==='lufs') html+=`<div class="lufs-panel"><div class="lufs-box"><div class="lufs-label">Mom</div><div class="lufs-val" id="lufs-m">-70.0</div></div><div class="lufs-box"><div class="lufs-label">ST</div><div class="lufs-val" id="lufs-s">-70.0</div></div><div class="lufs-box"><div class="lufs-label">Int</div><div class="lufs-val integrated" id="lufs-i">-70.0</div></div></div>`;
            if(mod.id==='output') html+=`<div class="output-device-wrap"><select id="outputDeviceSelect" disabled><option value="">🔊 Cargando...</option></select></div>`;
            el.innerHTML=html; grid.appendChild(el);
        });
        setupInteractions();
    }

    function setupInteractions() {
        document.querySelectorAll('.meter-box').forEach(box => {
            box.addEventListener('mousemove', e => { const db=parseFloat(box.dataset.db||'-60'),gr=parseFloat(box.dataset.gr||'0'); tooltip.textContent=`${box.dataset.id.toUpperCase()} → ${db.toFixed(1)} dBFS${gr>0.1?' | GR: -'+gr.toFixed(1)+' dB':''}`; tooltip.style.left=e.clientX+12+'px'; tooltip.style.top=e.clientY-28+'px'; tooltip.classList.add('show'); });
            box.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
        });
        document.querySelectorAll('.fader-track').forEach(track => {
            let drag=false, startY=0, startP=0;
            const update=y => { const rect=track.getBoundingClientRect(), p=Math.max(0,Math.min(1,startP-(y-startY)/rect.height)); const db=(p*24-12).toFixed(1); track.dataset.val=db; track.querySelector('.fader-thumb').style.bottom=`${p*100}%`; track.querySelector('.fader-fill').style.height=`${p*100}%`; track.nextElementSibling.querySelector('.ctrl-val').textContent=`${db} dB`; const st=channelStates.get(`${track.dataset.mod}_${track.dataset.ch}`); if(st&&audioCtx) st.gainNode.gain.setTargetAtTime(10**(db/20),audioCtx.currentTime,0.01); };
            const onStart=e => { drag=true; startY=e.clientY||e.touches[0].clientY; startP=parseFloat(track.dataset.val+12)/24; e.preventDefault(); };
            track.addEventListener('mousedown', onStart);
            track.addEventListener('touchstart', onStart, {passive:false});
            const onMove=e => { if(!drag) return; update(e.clientY||(e.touches&&e.touches[0].clientY)); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('touchmove', onMove, {passive:false});
            document.addEventListener('mouseup', ()=>drag=false);
            document.addEventListener('touchend', ()=>drag=false);
        });
        document.querySelectorAll('.slider').forEach(s => {
            s.addEventListener('input', () => { const mod=stages[s.dataset.mod]; if(!mod?.comp||!audioCtx) return; const v=parseFloat(s.value),el=document.getElementById(`pv_${s.dataset.mod}_${s.dataset.param}`); if(el) el.textContent=v.toFixed(2); const t=audioCtx.currentTime; if(s.dataset.param==='thr') mod.comp.threshold.setTargetAtTime(v,t,0.02); if(s.dataset.param==='ratio') mod.comp.ratio.setTargetAtTime(v,t,0.02); if(s.dataset.param==='atk') mod.comp.attack.setTargetAtTime(v,t,0.02); if(s.dataset.param==='rel') mod.comp.release.setTargetAtTime(v,t,0.02); if(s.dataset.param==='mkup') mod.makeupGain?.setTargetAtTime(10**(v/20),t,0.02); });
        });
        document.querySelectorAll('.btn-s, .btn-m').forEach(btn => {
            btn.addEventListener('click', () => { const key=`${btn.dataset.mod}_${btn.dataset.ch}`,st=channelStates.get(key); if(!st) return; if(btn.classList.contains('btn-s')){st.solo=!st.solo;btn.classList.toggle('active',st.solo);} else{st.mute=!st.mute;btn.classList.toggle('active',st.mute);} updateRouting(); });
        });
        document.getElementById('btnRefreshDevices').addEventListener('click', () => ioManager.refresh());
    }

    function updateRouting() { let anySolo=false; for(let st of channelStates.values()) if(st.solo){anySolo=true;break;} for(let [,st] of channelStates.entries()) { const target=st.mute?0.0001:(anySolo&&!st.solo?0.0001:1); st.muteNode.gain.setTargetAtTime(target,audioCtx.currentTime,0.02); } }

    async function initAudioEngine(streamOrBuffer) {
        if(audioCtx) {
            try { await audioCtx.close(); } catch(e) { console.error(e); }
        }
        cancelAnimationFrame(renderId);
        
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if(audioCtx.state === 'suspended') await audioCtx.resume();
        
        lufsEngine = new LUFSEngine(audioCtx);
        let source;
        if(streamOrBuffer instanceof MediaStream) source = audioCtx.createMediaStreamSource(streamOrBuffer);
        else if(streamOrBuffer instanceof AudioBuffer) { const src=audioCtx.createBufferSource(); src.buffer=streamOrBuffer; src.loop=true; source=src; src.start(0); }
        else return;

        // Intermediate gain to handle mono-to-stereo upmixing automatically
        const inputGain = audioCtx.createGain();
        source.connect(inputGain);

        const splitter=audioCtx.createChannelSplitter(2), merger=audioCtx.createChannelMerger(2);
        inputGain.connect(splitter);
        
        // Anchors for L/R chains
        const anchorL = audioCtx.createGain(), anchorR = audioCtx.createGain();
        splitter.connect(anchorL, 0);
        splitter.connect(anchorR, 1);
        
        let chainL=anchorL, chainR=anchorR;
        channelStates.clear();
        MODULES.forEach(mod => {
            stages[mod.id]={gainNodes:[], analyserIn:[], analyserOut:[], comp:null, makeupGain:null};
            mod.meters.forEach((_,i)=>{
                const isR=(mod.meters.length===4&&(i===1||i===3))||(mod.meters.length===2&&i===1);
                const prev=isR?chainR:chainL, key=`${mod.id}_${i}`;
                const aIn=audioCtx.createAnalyser(); aIn.fftSize=256; aIn.smoothingTimeConstant=0.35;
                const aOut=audioCtx.createAnalyser(); aOut.fftSize=256; aOut.smoothingTimeConstant=0.35;
                const gn=audioCtx.createGain(); gn.gain.value=1;
                const muteNode=audioCtx.createGain(); muteNode.gain.value=1;
                stages[mod.id].analyserIn.push(aIn); stages[mod.id].analyserOut.push(aOut); stages[mod.id].gainNodes.push(gn);
                channelStates.set(key,{muteNode, gainNode:gn, solo:false, mute:false});
                if(mod.type==='comp' && mod.params) {
                    const comp=audioCtx.createDynamicsCompressor(); comp.threshold.value=mod.params.thr; comp.knee.value=6; comp.ratio.value=mod.params.ratio; comp.attack.value=mod.params.atk; comp.release.value=mod.params.rel;
                    const mkup=audioCtx.createGain(); mkup.gain.value=10**(mod.params.mkup/20); stages[mod.id].comp=comp; stages[mod.id].makeupGain=mkup;
                    prev.connect(aIn); aIn.connect(comp); comp.connect(aOut); aOut.connect(mkup); mkup.connect(muteNode);
                } else { prev.connect(aIn); aIn.connect(aOut); aOut.connect(muteNode); }
                muteNode.connect(gn); if(isR) chainR=gn; else chainL=gn;
            });
        });
        chainL.connect(stages.output.analyserOut[0]); 
        chainR.connect(stages.output.analyserOut[1]);
        
        stages.output.analyserOut[0].connect(merger, 0, 0); 
        stages.output.analyserOut[1].connect(merger, 0, 1); 
        
        merger.connect(audioCtx.destination);
        updateRouting();
        renderId = requestAnimationFrame(renderLoop);
    }

    let lufsTimer=0;
    function renderLoop(time) {
        const dt=(time-(renderLoop.last||time))/16.67; renderLoop.last=time;
        MODULES.forEach(mod => { mod.meters.forEach((_,i)=>{ const stage=stages[mod.id]; if(!stage||!stage.analyserIn[i]) return; let dbIn=-60,dbOut=-60,gr=0; const bI=new Float32Array(stage.analyserIn[i].fftSize); stage.analyserIn[i].getFloatTimeDomainData(bI); const rI=Math.sqrt(bI.reduce((a,b)=>a+b*b,0)/bI.length); dbIn=rI>0?20*Math.log10(rI):-60; const bO=new Float32Array(stage.analyserOut[i].fftSize); stage.analyserOut[i].getFloatTimeDomainData(bO); const rO=Math.sqrt(bO.reduce((a,b)=>a+b*b,0)/bO.length); dbOut=rO>0?20*Math.log10(rO):-60; gr=Math.max(0,dbIn-dbOut); const db=Math.max(-60,Math.min(0,(mod.id==='input'||mod.id==='output')?dbOut:dbIn)); const pct=(db+60)/60; const box=document.querySelector(`[data-id="${mod.id}_${i}"]`); if(!box) return; box.dataset.db=db; box.dataset.gr=gr; const active=Math.round(pct*SEGMENTS); const leds=box.querySelectorAll('.led'); for(let s=0;s<SEGMENTS;s++) leds[s].className=`led ${s<active?(mod.meters.length===4&&(i<2)?'b':(s<33?'g':(s<42?'y':'r'))):(mod.meters.length===4&&(i<2)?'bd':(s<33?'gd':(s<42?'yd':'rd')))}`; const key=`${mod.id}_${i}`; if(!peakState[key]) peakState[key]=0; if(pct>peakState[key]) peakState[key]=pct; else peakState[key]-=PEAK_DECAY*dt; if(peakState[key]<0) peakState[key]=0; box.querySelector('.peak-line').style.top=`${(1-peakState[key])*100}%`; }); });
        if(lufsTimer++%2===0 && lufsEngine && stages.output?.analyserOut) { const dL=new Float32Array(stages.output.analyserOut[0].fftSize), dR=new Float32Array(stages.output.analyserOut[1].fftSize); stages.output.analyserOut[0].getFloatTimeDomainData(dL); stages.output.analyserOut[1].getFloatTimeDomainData(dR); const l=lufsEngine.calculate(dL,dR); document.getElementById('lufs-m').textContent=l.m.toFixed(1); document.getElementById('lufs-s').textContent=l.s.toFixed(1); document.getElementById('lufs-i').textContent=l.i.toFixed(1); }
        renderId = requestAnimationFrame(renderLoop);
    }

    function savePreset() { const p={}; document.querySelectorAll('.fader-track, .slider').forEach(el=>p[`${el.dataset.mod||''}_${el.dataset.ch||el.dataset.param}`]=parseFloat(el.dataset.val||el.value)); presets[activePreset]=p; localStorage.setItem('broadcastProPresetsV5',JSON.stringify(presets)); showToast('✅ Preset guardado'); }
    function loadPreset() { if(!presets[activePreset]) return showToast('⚠️ Sin preset'); Object.entries(presets[activePreset]).forEach(([k,v])=>{ const [modId,sub]=k.split('_'); const f=document.querySelector(`.fader-track[data-mod="${modId}"][data-ch="${sub}"]`); if(f){f.dataset.val=v; const p=(v+12)/24; f.querySelector('.fader-thumb').style.bottom=`${p*100}%`; f.querySelector('.fader-fill').style.height=`${p*100}%`; f.nextElementSibling.querySelector('.ctrl-val').textContent=`${v.toFixed(1)} dB`; const st=channelStates.get(`${modId}_${sub}`); if(st&&audioCtx) st.gainNode.gain.setTargetAtTime(10**(v/20),audioCtx.currentTime,0.02); return;} const s=document.querySelector(`.slider[data-mod="${modId}"][data-param="${sub}"]`); if(s){s.value=v;s.dispatchEvent(new Event('input'));} }); showToast('✅ Preset cargado'); }
    function resetAll() { document.querySelectorAll('.fader-track').forEach(f=>{f.dataset.val='0.0';f.querySelector('.fader-thumb').style.bottom='50%';f.querySelector('.fader-fill').style.height='50%';f.nextElementSibling.querySelector('.ctrl-val').textContent='0.0 dB';const st=channelStates.get(`${f.dataset.mod}_${f.dataset.ch}`);if(st&&audioCtx)st.gainNode.gain.setTargetAtTime(1,audioCtx.currentTime,0.02);}); document.querySelectorAll('.slider').forEach(s=>s.dispatchEvent(new Event('input'))); document.querySelectorAll('.btn-s,.btn-m').forEach(b=>{b.classList.remove('active');const st=channelStates.get(`${b.dataset.mod}_${b.dataset.ch}`);if(st){st.solo=false;st.mute=false;}}); updateRouting(); if(lufsEngine) lufsEngine.reset(); showToast('↺ Reset'); }

    document.getElementById('btnMic').onclick = async () => { 
        try { 
            currentStream = await navigator.mediaDevices.getUserMedia({
                audio:{
                    echoCancellation:false,
                    noiseSuppression:false,
                    autoGainControl:false
                }
            }); 
            await initAudioEngine(currentStream); 
            document.getElementById('btnMic').classList.add('active');
            showToast('🎤 Micrófono conectado'); 
            ioManager.refresh(); // Refresh device list
        } catch(e) { 
            showToast('⛔ Permiso bloqueado: ' + e.message);
            document.getElementById('btnMic').classList.remove('active');
        }
    };
    document.getElementById('fileInput').onchange = async (e) => { const f=e.target.files[0]; if(!f) return; try { if(audioCtx&&audioCtx.state==='suspended') await audioCtx.resume(); const buf=await f.arrayBuffer(); if(!audioCtx) audioCtx=new AudioContext(); initAudioEngine(await audioCtx.decodeAudioData(buf)); showToast('🎵 Archivo cargado'); } catch { showToast('⛔ Error al decodificar'); } };
    document.getElementById('btnSave').onclick = savePreset;
    document.getElementById('btnLoad').onclick = loadPreset;
    document.getElementById('btnReset').onclick = resetAll;

    buildUI();
    ioManager.init();
    ioManager.refresh();
});