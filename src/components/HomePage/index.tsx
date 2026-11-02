import styles from "./styles.module.scss";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarIcon, DotsVerticalIcon, ListBulletIcon, UpdateIcon } from "@radix-ui/react-icons";
import { Album, Singer, Track } from "@/models";
import { Button, AppFooter, MonthItem, Popover, Progress, SegmentedControl, Select, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, useToast } from '@/components';
import { fetchDataFromEndpoint } from "@/utils/fetchDataFromEndpoint";
import { authenticatedFetch, onUnauthorizedSession, performUnauthorizedLogout, UnauthorizedSessionError } from "@/utils/authenticatedFetch";
import { yearlyDataStorage, type MonthlyEntry } from '@/services/yearlyDataStorage';
import { secretPagesStorage } from '@/services/secretPagesStorage';
import { getMonthsNeedingFetch } from '@/utils/monthlyEntryCompleteness';
import type { YearlyDataType } from '@/services/supabaseService';
import { supabase } from "@/utils/supabase";
import { ModalExtraContent } from "../ModalExtraContent";
import { ModalInitialConfig } from "../ModalInitialConfig";

type DataLoadState = 'idle' | 'checking' | 'downloading';

export function HomePage() {
  const { show: showToast } = useToast();
  const currentYear = new Date().getFullYear();
  const [activeTab, setActiveTab] = useState<string>("albums");
  const [viewType, setViewType] = useState<string>("month");
  const [year, setYear] = useState<number>(currentYear - 1);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Singer[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [dataLoadState, setDataLoadState] = useState<DataLoadState>('idle');
  const [fetchProgressPercent, setFetchProgressPercent] = useState(0);
  const [authenticatedWithLastfm, setAuthenticatedWithLastfm] = useState<boolean>(false);
  const [lastfmUsername, setLastfmUsername] = useState<string | null>(null);
  const months = useMemo(() => [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ], []);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isRefreshingRef = useRef(false);
  const requestForceFullYearRefreshRef = useRef<() => void>(() => { });
  const defaultLatestSelectableYear = currentYear - 1;

  const [sessionStarted, setSessionStarted] = useState(false);
  const [canAccessCurrentYear, setCanAccessCurrentYear] = useState(false);
  const [yearAccessReady, setYearAccessReady] = useState(false);
  const [earliestSelectableYear, setEarliestSelectableYear] = useState(defaultLatestSelectableYear);
  const [extraModalOpen, setExtraModalOpen] = useState(false);
  const [extraModalPendingMonth, setExtraModalPendingMonth] = useState<number | null>(null);
  const [yearSelectRevision, setYearSelectRevision] = useState(0);
  const [viewTypeMenuOpen, setViewTypeMenuOpen] = useState(false);

  const latestSelectableYear = canAccessCurrentYear ? currentYear : defaultLatestSelectableYear;
  const effectiveEarliestYear = Math.min(earliestSelectableYear, latestSelectableYear);

  const yearOptions = useMemo(() => {
    const years = [];
    for (let i = effectiveEarliestYear; i <= latestSelectableYear; i++) {
      years.push({ value: String(i), label: String(i) });
    }
    return years;
  }, [effectiveEarliestYear, latestSelectableYear]);

  const handleTabChange = (value: string) => {
    if (year !== currentYear) {
      setDataLoadState('checking');
    }
    setActiveTab(value);
  };

  const handleYearChange = (value: string) => {
    const nextYear = Number(value);
    setYear(nextYear);
    setYearSelectRevision((r) => r + 1);
    if (nextYear !== currentYear) {
      setDataLoadState('checking');
    }
  };

  const handleSessionStarted = useCallback(() => {
    setSessionStarted(true);
  }, []);

  const handleExtraModalOpenChange = useCallback((nextOpen: boolean) => {
    setExtraModalOpen(nextOpen);
    if (!nextOpen) {
      setExtraModalPendingMonth(null);
    }
  }, []);

  const handlePendingMonthConsumed = useCallback(() => {
    setExtraModalPendingMonth(null);
  }, []);

  const handleModalYearChange = useCallback((nextYear: number) => {
    if (nextYear !== currentYear) {
      setDataLoadState('checking');
    }
    setYear(nextYear);
  }, [currentYear]);

  const openExtraModalForAlbumMonth = useCallback((monthIndex: number) => {
    setExtraModalPendingMonth(monthIndex);
    setExtraModalOpen(true);
  }, []);

  const handleViewTypeChange = (value: string) => {
    setViewType(value);
    setViewTypeMenuOpen(false);
  };

  const buildEmptyCurrentYearEntries = useCallback((): MonthlyEntry[] => {
    const currentMonthNameIndex = new Date().getMonth();
    return months.slice(0, currentMonthNameIndex + 1).map((month) => ({
      month,
      name: '',
      artist: '',
      imageUrl: '',
      scrobbles: 0,
    }));
  }, [months]);

  const fetchData = useCallback(async (
    endpoint: string,
    setter: React.Dispatch<React.SetStateAction<any[]>>,
    signal: AbortSignal,
    forceRefresh = false,
    forceFullYear = false,
  ) => {
    const dataType: YearlyDataType = endpoint === "fetch-albums-by-month" ? "albums" : endpoint === "fetch-artists-by-month" ? "artists" : "songs";
    const shouldBypassCache = forceRefresh || forceFullYear;
    const restoreFromStorage = async () => {
      const username = localStorage.getItem('lastfm_username');
      if (!username) return;
      const cached = await yearlyDataStorage.getYearlyData(username, year, dataType);
      if (cached && cached.length > 0) {
        setter(cached);
      }
    };

    try {
      const username = localStorage.getItem('lastfm_username');
      if (!username) {
        return;
      }
      if (!shouldBypassCache) {
        const storedData = await yearlyDataStorage.getYearlyData(
          username,
          year,
          dataType
        );

        if (storedData && storedData.length > 0) {
          setter(storedData);
          return;
        }

        if (year === currentYear) {
          setter(buildEmptyCurrentYearEntries());
          return;
        }
      }

      setDataLoadState('checking');
      const storedData = await yearlyDataStorage.getYearlyData(
        username,
        year,
        dataType
      );

      let monthsToDisplay = months;
      if (year === currentYear) {
        const currentMonthNameIndex = new Date().getMonth();
        monthsToDisplay = months.slice(0, currentMonthNameIndex + 1);
      }

      const monthsPayload = forceFullYear
        ? [...monthsToDisplay]
        : getMonthsNeedingFetch(
          storedData,
          months,
          dataType,
          year,
          currentYear
        );

      if (storedData && monthsPayload.length === 0) {
        setter(storedData);
        if (forceRefresh && !forceFullYear) {
          showToast({
            title: 'Nothing was updated',
            description: 'Your data for this year already looks complete.',
            variant: 'warning',
            duration: 12000,
            action: {
              label: 'Force Refresh',
              onClick: () => requestForceFullYearRefreshRef.current(),
            },
          });
        }
        return;
      }

      const orderedPayload = monthsPayload;

      const mapServerYearToDisplay = (yearRows: Album[] | Singer[] | Track[]) =>
        monthsToDisplay.map((monthName) => {
          return (
            yearRows.find((item: Album | Singer | Track) => item.month === monthName) ||
            storedData?.find((item) => item.month === monthName) ||
            { month: monthName, name: '', artist: '', imageUrl: '', scrobbles: 0 }
          );
        });

      const totalFetches = orderedPayload.length;
      if (totalFetches === 0) {
        if (storedData && storedData.length > 0) {
          setter(storedData);
        }
        return;
      }

      if (storedData && storedData.length > 0) {
        setter(storedData);
      }

      setDataLoadState('downloading');
      setFetchProgressPercent(0);
      let hadFetchFailure = false;

      for (let i = 0; i < orderedPayload.length; i++) {
        if (signal.aborted) break;
        const monthName = orderedPayload[i];
        const payload: Record<string, unknown> = {
          target_account: username,
          year,
          months: [monthName],
          ...(shouldBypassCache && { forceRefresh: true }),
        };
        try {
          const yearRows = (await fetchDataFromEndpoint(
            endpoint,
            payload,
            signal
          )) as Album[] | Singer[] | Track[];
          const displayData = mapServerYearToDisplay(yearRows);
          setter(displayData);
          const forStorage: MonthlyEntry[] = displayData.map((item) => ({
            month: item.month,
            name: item.name,
            artist: 'artist' in item && typeof item.artist === 'string' ? item.artist : '',
            imageUrl: item.imageUrl,
            scrobbles: item.scrobbles,
          }));
          await yearlyDataStorage.storeYearlyData(
            username,
            year,
            dataType,
            forStorage
          );
        } catch (monthError) {
          if (monthError instanceof UnauthorizedSessionError) {
            throw monthError;
          }
          hadFetchFailure = true;
          console.error(`Error fetching ${monthName} from ${endpoint}:`, monthError);
          await restoreFromStorage();
        }
        const done = i + 1;
        const pct =
          totalFetches === 0 ? 100 : Math.min(100, (done / totalFetches) * 100);
        setFetchProgressPercent(pct);
      }

      if (!signal.aborted) {
        await restoreFromStorage();
        if (hadFetchFailure) {
          showToast({
            title: 'Some months could not be updated',
            description: 'Showing the latest saved data we have.',
            variant: 'warning',
          });
        }
      }
    } catch (error) {
      if (error instanceof UnauthorizedSessionError) {
        return;
      }
      console.error(`Error fetching from ${endpoint}:`, error);
      await restoreFromStorage();
      if (!signal.aborted) {
        showToast({
          title: 'Could not load listening data',
          description: 'Showing saved data if available.',
          variant: 'error',
        });
      }
    } finally {
      setFetchProgressPercent(0);
      if (!signal.aborted) {
        setDataLoadState('idle');
      }
    }
  }, [year, months, currentYear, buildEmptyCurrentYearEntries, showToast]);

  const handleRefreshData = useCallback((forceFullYear = false) => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const { signal } = abortControllerRef.current;
    const onFinally = () => { isRefreshingRef.current = false; };
    let fetchPromise: Promise<void> | undefined;
    switch (activeTab) {
      case "albums":
        fetchPromise = fetchData("fetch-albums-by-month", setAlbums, signal, true, forceFullYear);
        break;
      case "artists":
        fetchPromise = fetchData("fetch-artists-by-month", setArtists, signal, true, forceFullYear);
        break;
      case "tracks":
        fetchPromise = fetchData("fetch-songs-by-month", setTracks, signal, true, forceFullYear);
        break;
      default:
        break;
    }
    if (fetchPromise && typeof fetchPromise.finally === 'function') {
      fetchPromise.finally(onFinally);
    } else {
      onFinally();
    }
  }, [activeTab, fetchData]);

  requestForceFullYearRefreshRef.current = () => {
    handleRefreshData(true);
  };

  useEffect(() => {
    if (!authenticatedWithLastfm) return;
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const { signal } = abortControllerRef.current;
    void (async () => {
      switch (activeTab) {
        case "albums":
          await fetchData("fetch-albums-by-month", setAlbums, signal);
          break;
        case "artists":
          await fetchData("fetch-artists-by-month", setArtists, signal);
          break;
        case "tracks":
          await fetchData("fetch-songs-by-month", setTracks, signal);
          break;
        default:
          break;
      }
    })();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [activeTab, year, fetchData, authenticatedWithLastfm]);

  const applyLoggedOutState = useCallback(() => {
    setSessionStarted(false);
    setAuthenticatedWithLastfm(false);
    setAlbums([]);
    setArtists([]);
    setTracks([]);
  }, []);

  useEffect(() => {
    return onUnauthorizedSession(applyLoggedOutState);
  }, [applyLoggedOutState]);

  useEffect(() => {
    if (!supabase) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem('lastfm_username');
        localStorage.removeItem('lastfm_token');
        localStorage.removeItem('lastfm_auth_started');
        applyLoggedOutState();
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [applyLoggedOutState]);

  useEffect(() => {
    if (!authenticatedWithLastfm) {
      setLastfmUsername(null);
      setCanAccessCurrentYear(false);
      setYearAccessReady(false);
      setEarliestSelectableYear(defaultLatestSelectableYear);
      return;
    }
    setLastfmUsername(localStorage.getItem("lastfm_username"));

    let cancelled = false;
    void (async () => {
      try {
        const res = await authenticatedFetch("/api/user/year-access");
        if (!res.ok) {
          if (!cancelled) setYearAccessReady(true);
          return;
        }
        const data = (await res.json()) as {
          canAccessCurrentYear?: boolean;
          earliestSelectableYear?: number;
        };
        if (!cancelled) {
          setCanAccessCurrentYear(Boolean(data.canAccessCurrentYear));
          if (
            typeof data.earliestSelectableYear === "number" &&
            Number.isFinite(data.earliestSelectableYear)
          ) {
            setEarliestSelectableYear(data.earliestSelectableYear);
          }
          setYearAccessReady(true);
        }
      } catch (error) {
        if (error instanceof UnauthorizedSessionError) return;
        if (!cancelled) {
          setCanAccessCurrentYear(false);
          setYearAccessReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authenticatedWithLastfm, defaultLatestSelectableYear]);

  useEffect(() => {
    if (canAccessCurrentYear || year !== currentYear) return;
    setYear(defaultLatestSelectableYear);
  }, [canAccessCurrentYear, currentYear, defaultLatestSelectableYear, year]);

  useEffect(() => {
    if (year >= effectiveEarliestYear) return;
    setYear(effectiveEarliestYear);
  }, [effectiveEarliestYear, year]);

  useEffect(() => {
    if (!authenticatedWithLastfm) {
      secretPagesStorage.clearSessionCache();
      return;
    }
    const username = localStorage.getItem("lastfm_username");
    if (!username) return;
    const selectedYear = year;
    let cancelled = false;
    void (async () => {
      await secretPagesStorage.prefetchYear(username, selectedYear, { refresh: true });
      if (cancelled) return;
      void secretPagesStorage.prefetchYear(username, selectedYear - 1);
      if (selectedYear < currentYear) void secretPagesStorage.prefetchYear(username, selectedYear + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticatedWithLastfm, currentYear, year]);

  useEffect(() => {
    secretPagesStorage.warmImages(albums.map((album) => album.imageUrl));
  }, [albums]);

  const handleLogout = async () => {
    await performUnauthorizedLogout();
  };

  const renderProgressBar = (name: string) => {
    return (
      <div className={styles.loadingWrapper}>
        <div className={styles.loading}>
          <Progress value={fetchProgressPercent} active />
        </div>
        <div className={styles.loadingText}>
          <span>Loading {name}...</span>
          <span className={styles.loadingSubtitle}>
            {Math.round(fetchProgressPercent)}%
          </span>
        </div>
      </div>
    );
  };

  const renderSpinnerLoading = () => {
    return (
      <div className={styles.loadingWrapper}>
        <Spinner size="large" />
      </div>
    );
  };

  const renderTabsContent = (name: string, items: any[]) => {
    const showLoading = activeTab === name && dataLoadState !== 'idle';
    return (
      <TabsContent value={name}>
        {showLoading && dataLoadState === 'downloading' ? (
          renderProgressBar(name)
        ) : showLoading && dataLoadState === 'checking' ? (
          renderSpinnerLoading()
        ) : (
          <div className={styles.monthsGrid}>
            {months.map((month, monthIndex) => {
              const item = items?.find(item => item.month === month) || null;
              return (
                <MonthItem
                  key={month}
                  month={month}
                  imageUrl={item?.imageUrl || undefined}
                  name={item?.name || ""}
                  artist={item?.artist || ""}
                  scrobbles={item?.scrobbles || null}
                  rounded={name === "artists"}
                  onClick={
                    name === "albums" && activeTab === "albums"
                      ? () => openExtraModalForAlbumMonth(monthIndex)
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </TabsContent>
    );
  };

  return (
    <>
      <div className={styles.background}>
        <div
          className={`${styles.gradientWrapper} ${activeTab === "albums"
            ? styles.albumsColors
            : activeTab === "artists"
              ? styles.artistsColors
              : styles.tracksColors
            }`}
        >
          <div className={styles.gradient1}></div>
          <div className={styles.gradient2}></div>
        </div>
        <div className={styles.noiseOverlay} aria-hidden />
        {authenticatedWithLastfm && (
          <div className={styles.mainWrapper}>
            <div className={styles.headerWrapper}>
              <h1>Archive of Our Songs</h1>
              <Select
                value={String(year)}
                onChange={handleYearChange}
                items={yearOptions}
                className={styles.yearSelect}
                loading={!yearAccessReady}
              />
            </div>
            <div className={styles.contentWrapper}>
              <Tabs value={activeTab} onValueChange={handleTabChange}>
                <TabsList sideIcons>
                  <TabsTrigger value="albums" ariaLabel="Albums">
                    <span className={styles.tabLabel}>Albums</span>
                  </TabsTrigger>
                  <TabsTrigger value="artists" ariaLabel="Artists">
                    <span className={styles.tabLabel}>Artists</span>
                  </TabsTrigger>
                  <TabsTrigger value="tracks" ariaLabel="Tracks">
                    <span className={styles.tabLabel}>Tracks</span>
                  </TabsTrigger>
                  <Button
                    variant="secondary"
                    size="small"
                    className={styles.refreshButton}
                    onClick={() => handleRefreshData(false)}
                    disabled={dataLoadState !== 'idle'}
                    ariaLabel="Refresh Data"
                  >
                    <UpdateIcon className={styles.refreshIcon} aria-hidden />
                    <span className={styles.refreshLabel}>Refresh Data</span>
                  </Button>
                  <div className={styles.sideIcons}>
                    <div className={styles.viewTypeDesktop}>
                      <SegmentedControl.Root
                        value={viewType}
                        size="1"
                        onValueChange={handleViewTypeChange}
                      >
                        <SegmentedControl.Item value="month">
                          <CalendarIcon />
                        </SegmentedControl.Item>
                        <SegmentedControl.Item value="list">
                          <ListBulletIcon />
                        </SegmentedControl.Item>
                      </SegmentedControl.Root>
                    </div>
                    <div className={styles.viewTypeMobile}>
                      <Popover
                        side="bottom"
                        align="end"
                        open={viewTypeMenuOpen}
                        onOpenChange={setViewTypeMenuOpen}
                        trigger={
                          <button
                            type="button"
                            className={styles.viewTypeMenuButton}
                            aria-label="View options"
                          >
                            <DotsVerticalIcon />
                          </button>
                        }
                      >
                        <button
                          type="button"
                          className={`${styles.viewTypeMenuItem}${viewType === "month" ? ` ${styles.viewTypeMenuItemActive}` : ""}`}
                          onClick={() => handleViewTypeChange("month")}
                        >
                          <CalendarIcon className={styles.viewTypeMenuIcon} aria-hidden />
                          Month
                        </button>
                        <button
                          type="button"
                          className={`${styles.viewTypeMenuItem}${viewType === "list" ? ` ${styles.viewTypeMenuItemActive}` : ""}`}
                          onClick={() => handleViewTypeChange("list")}
                        >
                          <ListBulletIcon className={styles.viewTypeMenuIcon} aria-hidden />
                          List
                        </button>
                      </Popover>
                    </div>
                  </div>
                </TabsList>
                {renderTabsContent("albums", albums)}
                {renderTabsContent("artists", artists)}
                {renderTabsContent("tracks", tracks)}
              </Tabs>
            </div>
            <ModalExtraContent
              year={year}
              albums={albums}
              open={extraModalOpen}
              onOpenChange={handleExtraModalOpenChange}
              yearSelectRevision={yearSelectRevision}
              onYearChange={handleModalYearChange}
              minYear={effectiveEarliestYear}
              maxYear={latestSelectableYear}
              pendingMonthIndex={extraModalPendingMonth}
              onPendingMonthConsumed={handlePendingMonthConsumed}
            />
          </div>
        )}
        {!sessionStarted && (
          <div className={styles.authBootstrapOverlay} aria-busy="true" aria-label="Checking session">
            <Spinner size="large" />
          </div>
        )}
        <AppFooter
          username={authenticatedWithLastfm ? lastfmUsername : null}
          onLogout={handleLogout}
        />
        <ModalInitialConfig
          authenticatedWithLastfm={authenticatedWithLastfm}
          setAuthenticatedWithLastfm={setAuthenticatedWithLastfm}
          onSessionStarted={handleSessionStarted}
        />
      </div>
    </>
  );
}
