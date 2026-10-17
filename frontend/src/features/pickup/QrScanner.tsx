import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CameraOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';

type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unavailable';

/**
 * Reads a QR code with the device camera. The camera is requested only when staff press
 * "Start camera", and released as soon as a code is read or the scanner closes. Decoding only
 * extracts the text — the server decides whether it is valid.
 */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const [state, setState] = useState<ScanState>('idle');

  function stop() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  useEffect(() => stop, []);

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable');
      return;
    }
    setState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setState('scanning');
      let last = 0;
      const tick = (time: number) => {
        frameRef.current = requestAnimationFrame(tick);
        if (time - last < 150 || video.readyState < 2) return;
        last = time;
        const canvas = canvasRef.current!;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(image.data, image.width, image.height, {
          inversionAttempts: 'dontInvert',
        });
        if (found?.data) {
          stop();
          setState('idle');
          onResult(found.data);
        }
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch (error) {
      stop();
      const name = (error as { name?: string }).name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={
          state === 'scanning' || state === 'starting'
            ? 'overflow-hidden rounded-(--radius-control) bg-espresso-900'
            : 'hidden'
        }
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className="aspect-square w-full object-cover"
          aria-label="Camera preview"
        />
      </div>
      <canvas ref={canvasRef} className="hidden" aria-hidden />
      {state === 'scanning' ? (
        <p role="status" className="text-sm text-espresso-700">
          Point the camera at the student’s QR code.
        </p>
      ) : state === 'denied' ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-chili-700">
          <CameraOff className="mt-0.5 size-4 shrink-0" aria-hidden />
          Camera access is blocked. Allow it in the browser’s site settings, or type the student’s
          code instead.
        </p>
      ) : state === 'unavailable' ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-chili-700">
          <CameraOff className="mt-0.5 size-4 shrink-0" aria-hidden />
          No camera is available on this device. Type the student’s code instead.
        </p>
      ) : null}
      {(state === 'idle' || state === 'denied' || state === 'unavailable') && (
        <Button
          variant="secondary"
          onClick={() => void start()}
          icon={<Camera className="size-4" aria-hidden />}
        >
          {state === 'idle' ? 'Start camera' : 'Try the camera again'}
        </Button>
      )}
      {state === 'scanning' && (
        <Button
          variant="ghost"
          onClick={() => {
            stop();
            setState('idle');
          }}
        >
          Stop camera
        </Button>
      )}
    </div>
  );
}
