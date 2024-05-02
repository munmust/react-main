/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane} from './ReactFiberLane';
import type {PriorityLevel} from 'scheduler/src/SchedulerPriorities';

import {enableDeferRootSchedulingToMicrotask} from 'shared/ReactFeatureFlags';
import {
  NoLane,
  NoLanes,
  SyncLane,
  getHighestPriorityLane,
  getNextLanes,
  includesSyncLane,
  markStarvedLanesAsExpired,
  markRootEntangled,
  mergeLanes,
  claimNextTransitionLane,
} from './ReactFiberLane';
import {
  CommitContext,
  NoContext,
  RenderContext,
  getExecutionContext,
  getWorkInProgressRoot,
  getWorkInProgressRootRenderLanes,
  isWorkLoopSuspendedOnData,
  performConcurrentWorkOnRoot,
  performSyncWorkOnRoot,
} from './ReactFiberWorkLoop';
import {LegacyRoot} from './ReactRootTags';
import {
  ImmediatePriority as ImmediateSchedulerPriority,
  UserBlockingPriority as UserBlockingSchedulerPriority,
  NormalPriority as NormalSchedulerPriority,
  IdlePriority as IdleSchedulerPriority,
  cancelCallback as Scheduler_cancelCallback,
  scheduleCallback as Scheduler_scheduleCallback,
  now,
} from './Scheduler';
import {
  DiscreteEventPriority,
  ContinuousEventPriority,
  DefaultEventPriority,
  IdleEventPriority,
  lanesToEventPriority,
} from './ReactEventPriorities';
import {
  supportsMicrotasks,
  scheduleMicrotask,
  shouldAttemptEagerTransition,
} from './ReactFiberConfig';

import ReactSharedInternals from 'shared/ReactSharedInternals';
const {ReactCurrentActQueue} = ReactSharedInternals;

// A linked list of all the roots with pending work. In an idiomatic app,
// there's only a single root, but we do support multi root apps, hence this
// extra complexity. But this module is optimized for the single root case.
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

// Used to prevent redundant mircotasks from being scheduled.
let didScheduleMicrotask: boolean = false;
// `act` "microtasks" are scheduled on the `act` queue instead of an actual
// microtask, so we have to dedupe those separately. This wouldn't be an issue
// if we required all `act` calls to be awaited, which we might in the future.
let didScheduleMicrotask_act: boolean = false;

// Used to quickly bail out of flushSync if there's no sync work to do.
let mightHavePendingSyncWork: boolean = false;

let isFlushingWork: boolean = false;

let currentEventTransitionLane: Lane = NoLane;

export function ensureRootIsScheduled(root: FiberRoot): void {
  // This function is called whenever a root receives an update. It does two
  // things 1) it ensures the root is in the root schedule, and 2) it ensures
  // there's a pending microtask to process the root schedule.
  //
  // Most of the actual scheduling logic does not happen until
  // `scheduleTaskForRootDuringMicrotask` runs.

  // 这个函数是在每个 root 接收到更新时调用的。它做了两件事：
  // 1）确保 root 在 root 调度中，
  // 2）确保有一个待处理的微任务来处理 root 调度。

  // Add the root to the schedule
  if (root === lastScheduledRoot || root.next !== null) {
    // Fast path. This root is already scheduled.
  } else {
    if (lastScheduledRoot === null) {
      firstScheduledRoot = lastScheduledRoot = root;
    } else {
      lastScheduledRoot.next = root;
      lastScheduledRoot = root;
    }
  }

  // Any time a root received an update, we set this to true until the next time
  // we process the schedule. If it's false, then we can quickly exit flushSync
  // without consulting the schedule.
  mightHavePendingSyncWork = true;

  // At the end of the current event, go through each of the roots and ensure
  // there's a task scheduled for each one at the correct priority.
  if (__DEV__ && ReactCurrentActQueue.current !== null) {
    // We're inside an `act` scope.
    if (!didScheduleMicrotask_act) {
      didScheduleMicrotask_act = true;
      scheduleImmediateTask(processRootScheduleInMicrotask);
    }
  } else {
    // 是否存在微任务调度
    if (!didScheduleMicrotask) {
      // 不存在的情况下，设置为true，并立即调度一个微任务
      didScheduleMicrotask = true;
      scheduleImmediateTask(processRootScheduleInMicrotask);
    }
  }

  if (!enableDeferRootSchedulingToMicrotask) {
    // While this flag is disabled, we schedule the render task immediately
    // instead of waiting a microtask.
    // TODO: We need to land enableDeferRootSchedulingToMicrotask ASAP to
    // unblock additional features we have planned.
    // 调度任务
    scheduleTaskForRootDuringMicrotask(root, now());
  }

  if (
    __DEV__ &&
    ReactCurrentActQueue.isBatchingLegacy &&
    root.tag === LegacyRoot
  ) {
    // Special `act` case: Record whenever a legacy update is scheduled.
    ReactCurrentActQueue.didScheduleLegacyUpdate = true;
  }
}
// 同步的刷新
export function flushSyncWorkOnAllRoots() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  flushSyncWorkAcrossRoots_impl(false);
}

export function flushSyncWorkOnLegacyRootsOnly() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  flushSyncWorkAcrossRoots_impl(true);
}

function flushSyncWorkAcrossRoots_impl(onlyLegacy: boolean) {
  if (isFlushingWork) {
    // Prevent reentrancy.
    // TODO: Is this overly defensive? The callers must check the execution
    // context first regardless.
    return;
  }

  if (!mightHavePendingSyncWork) {
    // Fast path. There's no sync work to do.
    return;
  }

  const workInProgressRoot = getWorkInProgressRoot();
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();

  // There may or may not be synchronous work scheduled. Let's check.
  let didPerformSomeWork;
  let errors: Array<mixed> | null = null;
  isFlushingWork = true;
  do {
    didPerformSomeWork = false;
    let root = firstScheduledRoot;
    while (root !== null) {
      if (onlyLegacy && root.tag !== LegacyRoot) {
        // Skip non-legacy roots.
      } else {
        // 计算出本次更新的批次Lanes
        const nextLanes = getNextLanes(
          root,
          root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
        );
        if (includesSyncLane(nextLanes)) {
          // This root has pending sync work. Flush it now.
          try {
            // TODO: Pass nextLanes as an argument instead of computing it again
            // inside performSyncWorkOnRoot.
            // 执行同步任务
            didPerformSomeWork = true;
            performSyncWorkOnRoot(root);
          } catch (error) {
            // Collect errors so we can rethrow them at the end
            if (errors === null) {
              errors = [error];
            } else {
              errors.push(error);
            }
          }
        }
      }
      root = root.next;
    }
  } while (didPerformSomeWork);
  isFlushingWork = false;

  // If any errors were thrown, rethrow them right before exiting.
  // TODO: Consider returning these to the caller, to allow them to decide
  // how/when to rethrow.
  if (errors !== null) {
    if (errors.length > 1) {
      if (typeof AggregateError === 'function') {
        // eslint-disable-next-line no-undef
        throw new AggregateError(errors);
      } else {
        for (let i = 1; i < errors.length; i++) {
          scheduleImmediateTask(throwError.bind(null, errors[i]));
        }
        const firstError = errors[0];
        throw firstError;
      }
    } else {
      const error = errors[0];
      throw error;
    }
  }
}

function throwError(error: mixed) {
  throw error;
}

function processRootScheduleInMicrotask() {
  // This function is always called inside a microtask. It should never be
  // called synchronously.
  // 这个函数总是在微任务中调用的。不应该同步调用。
  didScheduleMicrotask = false;
  if (__DEV__) {
    didScheduleMicrotask_act = false;
  }

  // We'll recompute this as we iterate through all the roots and schedule them.
  // 我们将在遍历所有根节点并调度它们时重新计算这个值。
  mightHavePendingSyncWork = false;

  const currentTime = now();

  let prev = null;
  let root = firstScheduledRoot; //
  while (root !== null) {
    // 遍历所有的root
    const next = root.next;

    if (
      currentEventTransitionLane !== NoLane &&
      shouldAttemptEagerTransition()
    ) {
      markRootEntangled(root, mergeLanes(currentEventTransitionLane, SyncLane));
    }

    const nextLanes = scheduleTaskForRootDuringMicrotask(root, currentTime);
    if (nextLanes === NoLane) {
      // This root has no more pending work. Remove it from the schedule. To
      // guard against subtle reentrancy bugs, this microtask is the only place
      // we do this — you can add roots to the schedule whenever, but you can
      // only remove them here.

      // Null this out so we know it's been removed from the schedule.
      root.next = null;
      if (prev === null) {
        // This is the new head of the list
        firstScheduledRoot = next;
      } else {
        prev.next = next;
      }
      if (next === null) {
        // This is the new tail of the list
        lastScheduledRoot = prev;
      }
    } else {
      // This root still has work. Keep it in the list.
      prev = root;
      if (includesSyncLane(nextLanes)) {
        mightHavePendingSyncWork = true;
      }
    }
    root = next;
  }

  currentEventTransitionLane = NoLane;

  // At the end of the microtask, flush any pending synchronous work. This has
  // to come at the end, because it does actual rendering work that might throw.
  // 在微任务结束时，刷新任何待处理的同步工作
  flushSyncWorkOnAllRoots();
}

function scheduleTaskForRootDuringMicrotask(
  root: FiberRoot,
  currentTime: number,
): Lane {
  // This function is always called inside a microtask, or at the very end of a
  // rendering task right before we yield to the main thread. It should never be
  // called synchronously.
  //
  // TODO: Unless enableDeferRootSchedulingToMicrotask is off. We need to land
  // that ASAP to unblock additional features we have planned.
  //
  // This function also never performs React work synchronously; it should
  // only schedule work to be performed later, in a separate task or microtask.

  // Check if any lanes are being starved by other work. If so, mark them as
  // expired so we know to work on those next.
  // 检查是否有任何 lanes 被其他工作占用。如果是，将它们标记为过期，以便我们知道下一个要处理的是它们。
  markStarvedLanesAsExpired(root, currentTime);

  // Determine the next lanes to work on, and their priority.
  // 得到workInProgressRoot和workInProgressRootRenderLanes
  const workInProgressRoot = getWorkInProgressRoot();
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();
  // 基于root.pendingLanes，计算出本次更新的批次Lanes
  const nextLanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
  );

  const existingCallbackNode = root.callbackNode; // 取出现行存在的回调节点【即任务task】， 默认是null
  if (
    // Check if there's nothing to work on
    // 如果优先级等于0 ，说明根节点没有可处理的回调，则退出任务调度
    nextLanes === NoLanes ||
    // If this root is currently suspended and waiting for data to resolve, don't
    // schedule a task to render it. We'll either wait for a ping, or wait to
    // receive an update.
    //
    // Suspended render phase
    (root === workInProgressRoot && isWorkLoopSuspendedOnData()) ||
    // Suspended commit phase
    root.cancelPendingCommit !== null
  ) {
    // Fast path: There's nothing to work on.
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return NoLane;
  }

  // Schedule a new callback in the host environment.
  if (includesSyncLane(nextLanes)) {
    // Synchronous work is always flushed at the end of the microtask, so we
    // don't need to schedule an additional task.
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackPriority = SyncLane;
    root.callbackNode = null;
    return SyncLane;
  } else {
    // We use the highest priority lane to represent the priority of the callback.
    // 检查现在的优先级
    const existingCallbackPriority = root.callbackPriority;
    // 获取最高优先级的lane
    const newCallbackPriority = getHighestPriorityLane(nextLanes);
    // 检查现在的优先级和新的优先级是否相同
    // 如果新的任务优先级与现存优先级相同，则不会发起新的调度任务。这种情况在组件触发更新时比较常见，
    // 比如类组件在一个DOM事件中多次调用了this.setState或者函数组件多次调用了useState的set方法，
    // 这种情况下只有第一次的修改会发起新的调度任务，后续的修改则会复用前面的任务，不会发起新的调度任务
    if (
      newCallbackPriority === existingCallbackPriority &&
      // Special case related to `act`. If the currently scheduled task is a
      // Scheduler task, rather than an `act` task, cancel it and re-schedule
      // on the `act` queue.
      !(
        __DEV__ &&
        ReactCurrentActQueue.current !== null &&
        existingCallbackNode !== fakeActCallbackNode
      )
    ) {
      // The priority hasn't changed. We can reuse the existing task.
      // 如果相同，则表示优先级无变化，可以重用当前任务
      // 这种情况一般出现在：多个状态触发的更新，可以共用一个调度任务，不会发起新的调度
      return newCallbackPriority;
    } else {
      // Cancel the existing callback. We'll schedule a new one below.
      // 如果不相同，则取消当前任务，重新发起调度
      cancelCallback(existingCallbackNode);
    }
    // 新的优先级
    let schedulerPriorityLevel;
    switch (lanesToEventPriority(nextLanes)) {
      // 同步优先级（离散事件优先级:click、blur）
      case DiscreteEventPriority:
        schedulerPriorityLevel = ImmediateSchedulerPriority;
        break;
      // 连续事件优先级（连续事件优先级：mouseOn、scroll...）
      case ContinuousEventPriority:
        schedulerPriorityLevel = UserBlockingSchedulerPriority;
        break;
      // 默认事件优先级
      case DefaultEventPriority:
        schedulerPriorityLevel = NormalSchedulerPriority;
        break;
      // 空闲事件优先级
      case IdleEventPriority:
        schedulerPriorityLevel = IdleSchedulerPriority;
        break;
      default:
        schedulerPriorityLevel = NormalSchedulerPriority;
        break;
    }
    // 创建新的task，以及生成一个新的宏任务来处理回调
    const newCallbackNode = scheduleCallback(
      schedulerPriorityLevel,
      // 最终要执行的cb回调任务 , 使用bind这种方式的好处，可以传递传递参数，又可以传递函数进去
      performConcurrentWorkOnRoot.bind(null, root),
    );

    root.callbackPriority = newCallbackPriority;
    // 设置根节点的回调节点 为新的任务task
    root.callbackNode = newCallbackNode;
    return newCallbackPriority;
  }
}

export type RenderTaskFn = (didTimeout: boolean) => RenderTaskFn | null;

export function getContinuationForRoot(
  root: FiberRoot,
  originalCallbackNode: mixed,
): RenderTaskFn | null {
  // This is called at the end of `performConcurrentWorkOnRoot` to determine
  // if we need to schedule a continuation task.
  //
  // Usually `scheduleTaskForRootDuringMicrotask` only runs inside a microtask;
  // however, since most of the logic for determining if we need a continuation
  // versus a new task is the same, we cheat a bit and call it here. This is
  // only safe to do because we know we're at the end of the browser task.
  // So although it's not an actual microtask, it might as well be.
  scheduleTaskForRootDuringMicrotask(root, now());
  if (root.callbackNode === originalCallbackNode) {
    // The task node scheduled for this root is the same one that's
    // currently executed. Need to return a continuation.
    return performConcurrentWorkOnRoot.bind(null, root);
  }
  return null;
}

const fakeActCallbackNode = {};

function scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: RenderTaskFn,
) {
  if (__DEV__ && ReactCurrentActQueue.current !== null) {
    // Special case: We're inside an `act` scope (a testing utility).
    // Instead of scheduling work in the host environment, add it to a
    // fake internal queue that's managed by the `act` implementation.
    ReactCurrentActQueue.current.push(callback);
    return fakeActCallbackNode;
  } else {
    return Scheduler_scheduleCallback(priorityLevel, callback);
  }
}

function cancelCallback(callbackNode: mixed) {
  if (__DEV__ && callbackNode === fakeActCallbackNode) {
    // Special `act` case: check if this is the fake callback node used by
    // the `act` implementation.
  } else if (callbackNode !== null) {
    Scheduler_cancelCallback(callbackNode);
  }
}

function scheduleImmediateTask(cb: () => mixed) {
  if (__DEV__ && ReactCurrentActQueue.current !== null) {
    // Special case: Inside an `act` scope, we push microtasks to the fake `act`
    // callback queue. This is because we currently support calling `act`
    // without awaiting the result. The plan is to deprecate that, and require
    // that you always await the result so that the microtasks have a chance to
    // run. But it hasn't happened yet.
    ReactCurrentActQueue.current.push(() => {
      cb();
      return null;
    });
  }

  // TODO: Can we land supportsMicrotasks? Which environments don't support it?
  // Alternatively, can we move this check to the host config?
  // 如果支持微任务，直接调度微任务
  // 优化处理：同步事件中多次修改state的场景，避免每次修改数据都需要发起新的调度任务，可以共用一个调度任务
  // 同步更新任务默认是添加到微任务队列之中执行的，所以即使同步任务也并不一定是立即执行的
  if (supportsMicrotasks) {
    scheduleMicrotask(() => {
      // In Safari, appending an iframe forces microtasks to run.
      // https://github.com/facebook/react/issues/22459
      // We don't support running callbacks in the middle of render
      // or commit so we need to check against that.
      const executionContext = getExecutionContext();
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
        // Note that this would still prematurely flush the callbacks
        // if this happens outside render or commit phase (e.g. in an event).

        // Intentionally using a macrotask instead of a microtask here. This is
        // wrong semantically but it prevents an infinite loop. The bug is
        // Safari's, not ours, so we just do our best to not crash even though
        // the behavior isn't completely correct.
        Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb);
        return;
      }
      cb();
    });
  } else {
    // If microtasks are not supported, use Scheduler.
    // 如果不支持微任务，使用Scheduler调度
    Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb);
  }
}

export function requestTransitionLane(): Lane {
  // The algorithm for assigning an update to a lane should be stable for all
  // updates at the same priority within the same event. To do this, the
  // inputs to the algorithm must be the same.
  //
  // The trick we use is to cache the first of each of these inputs within an
  // event. Then reset the cached values once we can be sure the event is
  // over. Our heuristic for that is whenever we enter a concurrent work loop.
  if (currentEventTransitionLane === NoLane) {
    // All transitions within the same event are assigned the same lane.
    currentEventTransitionLane = claimNextTransitionLane();
  }
  return currentEventTransitionLane;
}
