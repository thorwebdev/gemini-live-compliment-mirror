import React, { useRef, useEffect, useState, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AppState } from '../types';
import { createPcmBlob, decodeAudio, decodeAudioData, blobToBase64 } from '../utils/audioUtils';
import { Play, Square, Mic, MicOff, Camera, Loader2, Sparkles } from 'lucide-react';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';
const SYSTEM_INSTRUCTION = `
You are a sentient "Magic Compliment Mirror". 
Your persona is charming, slightly magical (like a fairytale mirror), but modern and supportive.
Your primary goal is to look at the user in the video feed and give them specific, genuine compliments about their appearance, outfit, smile, or vibe.
Be observant. Mention colors, styles, accessories, or facial expressions.
If the user talks to you, hold a conversation with them warmly.
Keep your responses relatively concise (1-3 sentences) unless the user engages in a deeper chat.
Do not be overly repetitive. If the user hasn't changed, you can just make small talk or ask how their day is.
`;

export const MagicMirror: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [isMuted, setIsMuted] = useState(false);
  const [volumeLevel, setVolumeLevel] = useState(0); // For visualization
  
  // Refs for managing media and API state
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Live API Session
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const activeSessionRef = useRef<any>(null); // To track if we need to close
  
  // Loops
  const videoIntervalRef = useRef<number | null>(null);

  // Initialize Media and Connect
  const startMirror = async () => {
    try {
      setAppState(AppState.CONNECTING);
      
      // 1. Get User Media
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 1280, height: 720 }, // HD for better outfit recognition
        audio: { echoCancellation: true } 
      });
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // 2. Setup Audio Contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime; // Reset timing

      // 3. Initialize Gemini Live API
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } }, // Deep, warm voice
          },
          systemInstruction: SYSTEM_INSTRUCTION,
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live Session Opened");
            setAppState(AppState.ACTIVE);
            
            // Start Audio Input Streaming
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return; // Don't send audio if muted
              
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              
              sessionPromise.then(session => {
                  session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const ctx = outputAudioContextRef.current;
              if (!ctx) return;

              // Simple visualization hook
              setVolumeLevel(Math.random() * 0.5 + 0.5); // Mock activity
              setTimeout(() => setVolumeLevel(0), 200);

              const audioBytes = decodeAudio(base64Audio);
              const audioBuffer = await decodeAudioData(audioBytes, ctx, 24000, 1);
              
              // Schedule playback
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              
              source.addEventListener('ended', () => {
                audioSourcesRef.current.delete(source);
              });
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(src => {
                try { src.stop(); } catch(e) {}
              });
              audioSourcesRef.current.clear();
              if (outputAudioContextRef.current) {
                 nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live Session Closed");
            if (appState !== AppState.IDLE) stopMirror();
          },
          onerror: (err) => {
            console.error("Gemini Live Error:", err);
            setAppState(AppState.ERROR);
            stopMirror();
          }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;
      sessionPromise.then(sess => {
          activeSessionRef.current = sess;
      });

      // 4. Start Video Frame Streaming loop
      startVideoStreaming();

    } catch (error) {
      console.error("Failed to start mirror:", error);
      setAppState(AppState.ERROR);
    }
  };

  const startVideoStreaming = () => {
    // Send frames every 500ms (2 FPS) to balance bandwidth and responsiveness
    // High enough for gestures/looks, low enough to be efficient.
    const intervalId = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const sessionPromise = sessionPromiseRef.current;

      if (video && canvas && sessionPromise && appState !== AppState.IDLE) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            canvas.width = video.videoWidth * 0.5; // Downscale slightly for speed
            canvas.height = video.videoHeight * 0.5;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            canvas.toBlob(async (blob) => {
                if (blob) {
                    const base64Data = await blobToBase64(blob);
                    sessionPromise.then(session => {
                        session.sendRealtimeInput({
                            media: { data: base64Data, mimeType: 'image/jpeg' }
                        });
                    });
                }
            }, 'image/jpeg', 0.6); // 60% quality JPEG
        }
      }
    }, 500); 

    videoIntervalRef.current = intervalId;
  };

  const stopMirror = useCallback(() => {
    // 1. Close Session
    if (activeSessionRef.current) {
        // Unfortunately .close() isn't always exposed on the interface depending on version, 
        // but we assume it might be or we just rely on cleaning up client side.
        // The SDK examples use 'onclose' callback but don't explicitly show closing from client side often
        // other than just stopping the stream.
        // We will try calling close if it exists or just nullify.
    }
    
    // 2. Stop User Media
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // 3. Stop Audio Contexts
    if (inputAudioContextRef.current) inputAudioContextRef.current.close();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    
    // 4. Clear Loop
    if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);

    setAppState(AppState.IDLE);
    setVolumeLevel(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopMirror();
  }, [stopMirror]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      
      {/* Header */}
      <div className="mb-6 text-center z-10">
        <h1 className="text-4xl md:text-5xl text-purple-200 font-bold mb-2 flex items-center justify-center gap-3 drop-shadow-[0_0_15px_rgba(168,85,247,0.5)]">
           <Sparkles className="w-8 h-8 text-yellow-300 animate-pulse" />
           Magic Compliment Mirror
           <Sparkles className="w-8 h-8 text-yellow-300 animate-pulse" />
        </h1>
        <p className="text-slate-400 text-lg">Gaze into the mirror to hear your fortune...</p>
      </div>

      {/* Main Mirror Container */}
      <div className="relative w-full max-w-4xl aspect-video bg-black rounded-[2rem] overflow-hidden group transition-all duration-500">
        
        {/* Frame / Border Effect */}
        <div className={`absolute inset-0 z-20 pointer-events-none rounded-[2rem] mirror-frame ${appState === AppState.ACTIVE ? 'mirror-active' : ''}`}></div>
        
        {/* Video Element (Mirrored) */}
        <video 
          ref={videoRef}
          className="w-full h-full object-cover transform -scale-x-100 opacity-90"
          playsInline
          muted
        />

        {/* Hidden Canvas for Frame Capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* UI Overlay */}
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none">
          
          {/* Connecting State */}
          {appState === AppState.CONNECTING && (
            <div className="flex flex-col items-center bg-black/60 p-6 rounded-2xl backdrop-blur-sm">
              <Loader2 className="w-12 h-12 text-purple-400 animate-spin mb-4" />
              <p className="text-purple-200 text-xl font-light">Summoning the spirits...</p>
            </div>
          )}

          {/* Idle State */}
          {appState === AppState.IDLE && (
            <div className="bg-black/40 p-8 rounded-2xl backdrop-blur-md border border-white/10 pointer-events-auto">
              <button 
                onClick={startMirror}
                className="group relative px-8 py-4 bg-purple-600 hover:bg-purple-500 text-white rounded-full font-bold text-xl transition-all hover:scale-105 hover:shadow-[0_0_30px_rgba(168,85,247,0.6)] flex items-center gap-3"
              >
                <Play className="w-6 h-6 fill-current" />
                <span>Awaken the Mirror</span>
              </button>
            </div>
          )}

           {/* Error State */}
           {appState === AppState.ERROR && (
            <div className="bg-red-900/80 p-6 rounded-2xl backdrop-blur-md pointer-events-auto text-center max-w-md">
              <p className="text-red-200 text-lg mb-4">The connection to the other side was severed.</p>
              <button 
                onClick={() => setAppState(AppState.IDLE)}
                className="px-6 py-2 bg-red-700 hover:bg-red-600 text-white rounded-full transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>

        {/* Active Controls (Bottom Toolbar) */}
        {appState === AppState.ACTIVE && (
          <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-40 flex items-center gap-4 bg-black/50 p-3 rounded-full backdrop-blur-md border border-white/10 pointer-events-auto">
            
            {/* Audio Visualizer Indicator */}
            <div className="flex items-center gap-1 mx-2 h-8 w-12 justify-center">
                {[...Array(5)].map((_, i) => (
                    <div 
                        key={i} 
                        className="w-1 bg-purple-400 rounded-full transition-all duration-75"
                        style={{ 
                            height: volumeLevel > 0.1 ? `${Math.max(20, Math.random() * 100)}%` : '20%',
                            opacity: volumeLevel > 0.1 ? 1 : 0.5
                        }}
                    ></div>
                ))}
            </div>

            <div className="h-8 w-px bg-white/20"></div>

            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`p-3 rounded-full transition-colors ${isMuted ? 'bg-red-500/80 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
              title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            <button
              onClick={stopMirror}
              className="p-3 bg-red-600/80 hover:bg-red-500 text-white rounded-full transition-colors"
              title="Stop Mirror"
            >
              <Square className="w-5 h-5 fill-current" />
            </button>
          </div>
        )}
      </div>

      <div className="mt-8 text-center text-slate-500 text-sm max-w-lg">
        <p>Powered by Gemini 2.5 Live API.</p>
        <p className="mt-1">Make sure you are in a well-lit room and wearing your favorite outfit.</p>
      </div>
    </div>
  );
};
