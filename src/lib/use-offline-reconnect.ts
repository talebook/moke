'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { create } from 'zustand';
import { checkWelcomeRequirement, fetchCurrentUser, MokeApiError } from '@/lib/api';
import { reconnectOfflineServer } from '@/lib/offline-reconnect';
import { useServerStore } from '@/lib/store/server';

// Sidebar and settings can coexist. Only one entry may restore the session.
const useReconnectPending = create(() => ({ reconnecting: false, owner: null as symbol | null }));
let activeReconnect: AbortController | null = null;

function cancelReconnect(controller = activeReconnect) {
  if (!controller || activeReconnect !== controller) return;
  activeReconnect = null;
  controller.abort();
  useReconnectPending.setState({ reconnecting: false, owner: null });
}

export function useOfflineReconnect() {
  const router = useRouter();
  const { reconnecting, owner } = useReconnectPending();
  const [entryId] = useState(() => Symbol('offline-reconnect-entry'));
  const [reconnectError, setReconnectError] = useState('');
  const reconnectRef = useRef<AbortController | null>(null);

  useEffect(() => () => { cancelReconnect(reconnectRef.current); }, []);

  const connectServer = async () => {
    if (activeReconnect) return;
    const controller = new AbortController();
    activeReconnect = controller;
    reconnectRef.current = controller;
    setReconnectError('');
    useReconnectPending.setState({ reconnecting: true, owner: entryId });
    try {
      const result = await reconnectOfflineServer({
        checkAccess: checkWelcomeRequirement,
        fetchUser: fetchCurrentUser,
      }, controller.signal);
      if ('cancelled' in result) return;
      router.push(result.target);
    } catch (error) {
      if (!controller.signal.aborted) {
        setReconnectError(error instanceof MokeApiError && error.code.startsWith('reader.') ? error.message
          : error instanceof Error && error.message.startsWith('连接超时')
          ? error.message : '无法恢复服务器连接，请检查网络后重试，或选择服务器重新连接。');
      }
    } finally {
      if (reconnectRef.current === controller) reconnectRef.current = null;
      if (activeReconnect === controller) {
        activeReconnect = null;
        useReconnectPending.setState({ reconnecting: false, owner: null });
      }
    }
  };

  const cancelConnection = () => {
    cancelReconnect();
    setReconnectError('');
  };

  const chooseServer = () => {
    cancelConnection();
    useServerStore.getState().cancelConnection();
    router.push('/welcome');
  };

  return {
    reconnecting,
    reconnectStatus: reconnecting && owner === entryId,
    reconnectError: reconnecting ? '' : reconnectError,
    connectServer,
    cancelConnection,
    chooseServer,
  };
}
