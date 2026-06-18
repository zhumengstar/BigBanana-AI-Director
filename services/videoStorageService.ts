import { ProjectState, Shot } from '../types';
import { fetchMediaWithCorsFallback } from './mediaFetchService';

const VIDEO_DIRECTORY_NAME = 'videos';
const OPFS_VIDEO_PREFIX = 'opfs://video/';

interface PersistVideoOptions {
  projectId?: string;
  episodeId?: string;
  shotId?: string;
}

interface ResolvePlaybackResult {
  src: string;
  revoke?: () => void;
}

const getStorageManager = (): (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | null => {
  if (typeof navigator === 'undefined' || !navigator.storage) return null;
  return navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
};

const sanitizeSegment = (value?: string): string => {
  if (!value) return '';
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 24);
};

const getVideoExtension = (mimeType?: string): string => {
  const normalized = (mimeType || '').toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('ogg')) return 'ogv';
  return 'mp4';
};

let videoDirectoryPromise: Promise<FileSystemDirectoryHandle> | null = null;

const getVideoDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  if (videoDirectoryPromise) return videoDirectoryPromise;

  const storage = getStorageManager();
  if (!storage?.getDirectory) {
    throw new Error('OPFS is not supported in this browser.');
  }

  videoDirectoryPromise = storage
    .getDirectory()
    .then(root => root.getDirectoryHandle(VIDEO_DIRECTORY_NAME, { create: true }))
    .catch(error => {
      videoDirectoryPromise = null;
      throw error;
    });

  return videoDirectoryPromise;
};

export const supportsOPFSVideoStorage = (): boolean => {
  return !!getStorageManager()?.getDirectory;
};

export const isOpfsVideoRef = (value?: string): boolean => {
  if (!value) return false;
  return value.startsWith(OPFS_VIDEO_PREFIX);
};

export const isVideoDataUrl = (value?: string): boolean => {
  if (!value) return false;
  return value.startsWith('data:video/');
};

export const dataUrlToBlob = (dataUrl: string): Blob => {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) throw new Error('Invalid data URL format.');

  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeMatch = header.match(/^data:([^;]+);base64$/i);
  if (!mimeMatch) throw new Error('Unsupported data URL encoding.');

  const mimeType = mimeMatch[1] || 'application/octet-stream';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const blobToDataUrl = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to convert blob to data URL.'));
    reader.readAsDataURL(blob);
  });
};

const createVideoFileName = (blob: Blob, options?: PersistVideoOptions): string => {
  const parts = [
    sanitizeSegment(options?.projectId),
    sanitizeSegment(options?.episodeId),
    sanitizeSegment(options?.shotId),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].filter(Boolean);

  const extension = getVideoExtension(blob.type);
  return `${parts.join('_') || 'video'}.${extension}`;
};

const uploadBlobToServerMedia = async (blob: Blob, options?: PersistVideoOptions): Promise<string> => {
  const dataUrl = await blobToDataUrl(blob);
  const response = await fetch('/api/project-store/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataUrl,
      folder: 'videos',
      filenamePrefix: createVideoFileName(blob, options).replace(/\.[^.]+$/, ''),
    }),
  });

  let result: any = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }

  if (!response.ok || !result?.ok || !result?.url) {
    throw new Error(result?.message || `Server media upload failed: HTTP ${response.status}`);
  }

  return result.url;
};

const opfsRefToFileName = (ref: string): string => {
  return decodeURIComponent(ref.slice(OPFS_VIDEO_PREFIX.length));
};

const blobToOpfsRef = async (blob: Blob, options?: PersistVideoOptions): Promise<string> => {
  const directory = await getVideoDirectory();
  const fileName = createVideoFileName(blob, options);
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return `${OPFS_VIDEO_PREFIX}${encodeURIComponent(fileName)}`;
};

const fetchBlobFromUrl = async (url: string): Promise<Blob> => {
  const response = await fetchMediaWithCorsFallback(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media: HTTP ${response.status}`);
  }
  return response.blob();
};

const readBlobFromOpfsRef = async (ref: string): Promise<Blob> => {
  const directory = await getVideoDirectory();
  const fileName = opfsRefToFileName(ref);
  const handle = await directory.getFileHandle(fileName, { create: false });
  const file = await handle.getFile();
  return new Blob([file], { type: file.type || 'video/mp4' });
};

export const persistVideoReference = async (
  value: string,
  options?: PersistVideoOptions
): Promise<string> => {
  if (!value || value.startsWith('/api/project-store/media/')) {
    return value;
  }

  try {
    let blob: Blob;
    if (isVideoDataUrl(value)) {
      blob = dataUrlToBlob(value);
    } else if (/^https?:\/\//i.test(value) || value.startsWith('blob:')) {
      blob = await fetchBlobFromUrl(value);
    } else {
      return value;
    }

    const serverUrl = await uploadBlobToServerMedia(blob, options);
    if (value.startsWith('blob:')) {
      URL.revokeObjectURL(value);
    }
    return serverUrl;
  } catch (serverError) {
    if (!supportsOPFSVideoStorage() || isOpfsVideoRef(value)) {
      console.warn('Persist video to server failed, fallback to original value.', serverError);
      return value;
    }

    try {
      let blob: Blob;
      if (isVideoDataUrl(value)) {
        blob = dataUrlToBlob(value);
      } else if (/^https?:\/\//i.test(value) || value.startsWith('blob:')) {
        blob = await fetchBlobFromUrl(value);
      } else {
        return value;
      }

      const opfsRef = await blobToOpfsRef(blob, options);
      if (value.startsWith('blob:')) {
        URL.revokeObjectURL(value);
      }
      return opfsRef;
    } catch (opfsError) {
      console.warn('Persist video to server and OPFS failed, fallback to original value.', opfsError);
    }
    return value;
  }
};

export const resolveVideoToBlob = async (value: string): Promise<Blob> => {
  if (!value) throw new Error('Video reference is empty.');
  if (isOpfsVideoRef(value)) {
    return readBlobFromOpfsRef(value);
  }
  if (value.startsWith('data:')) {
    return dataUrlToBlob(value);
  }
  return fetchBlobFromUrl(value);
};

export const resolveVideoPlaybackSrc = async (value: string): Promise<ResolvePlaybackResult> => {
  if (!value) return { src: '' };
  if (!isOpfsVideoRef(value)) return { src: value };

  const blob = await resolveVideoToBlob(value);
  const objectUrl = URL.createObjectURL(blob);
  return {
    src: objectUrl,
    revoke: () => URL.revokeObjectURL(objectUrl),
  };
};

export const migrateProjectVideosToOPFS = async (
  project: ProjectState
): Promise<{ project: ProjectState; changed: boolean; migratedCount: number }> => {
  if (!project?.shots?.length) {
    return { project, changed: false, migratedCount: 0 };
  }

  let changed = false;
  let migratedCount = 0;
  const updatedShots: Shot[] = [];

  for (const shot of project.shots) {
    const currentValue = shot.interval?.videoUrl;
    if (!currentValue || !isVideoDataUrl(currentValue)) {
      updatedShots.push(shot);
      continue;
    }

    const persisted = await persistVideoReference(currentValue, {
      projectId: project.projectId || project.id,
      episodeId: project.id,
      shotId: shot.id,
    });

    if (persisted !== currentValue && shot.interval) {
      changed = true;
      migratedCount++;
      updatedShots.push({
        ...shot,
        interval: {
          ...shot.interval,
          videoUrl: persisted,
        },
      });
      continue;
    }

    updatedShots.push(shot);
  }

  if (!changed) {
    return { project, changed: false, migratedCount: 0 };
  }

  return {
    project: {
      ...project,
      shots: updatedShots,
    },
    changed: true,
    migratedCount,
  };
};

export const materializeProjectVideosForExport = async (project: ProjectState): Promise<ProjectState> => {
  if (!project?.shots?.length) return project;

  let changed = false;
  const updatedShots: Shot[] = [];
  const failedOpfsShots: string[] = [];

  for (const shot of project.shots) {
    const value = shot.interval?.videoUrl;
    if (!value || !isOpfsVideoRef(value)) {
      updatedShots.push(shot);
      continue;
    }

    try {
      const blob = await resolveVideoToBlob(value);
      const dataUrl = await blobToDataUrl(blob);
      changed = true;
      updatedShots.push({
        ...shot,
        interval: shot.interval
          ? {
              ...shot.interval,
              videoUrl: dataUrl,
            }
          : shot.interval,
      });
    } catch (error) {
      console.warn('Materialize OPFS video for export failed.', error);
      failedOpfsShots.push(shot.id);
      updatedShots.push(shot);
    }
  }

  if (failedOpfsShots.length > 0) {
    throw new Error(
      `Failed to export ${failedOpfsShots.length} OPFS video(s): ${failedOpfsShots.join(', ')}`
    );
  }

  if (!changed) return project;
  return {
    ...project,
    shots: updatedShots,
  };
};
