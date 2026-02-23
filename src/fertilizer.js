/**
 * 化肥自动化模块
 *
 * 功能：
 *   1. 自动开启背包中的化肥礼包（100003 化肥礼包、100004 有机化肥礼包）
 *   2. 背包中化肥道具数量超过目标阈值时，自动使用多余部分（填充化肥容器）
 *
 * 配置（通过环境变量）：
 *   AUTO_USE_FERTILIZER=true        - 开启功能（默认关闭）
 *   FERTILIZER_TARGET_COUNT=100     - 化肥道具保留目标数量（默认 100）
 *   FERTILIZER_PACK_DAILY_LIMIT=0   - 每日最多开启礼包数（0 不限，默认 0）
 */

const { CONFIG } = require('./config');
const { types } = require('./proto');
const { sendMsgAsync } = require('./network');
const { toLong, toNum, log, logWarn, sleep } = require('./utils');
const { getBag, getBagItems } = require('./warehouse');

// ============ 常量 ============

/** 回退模式下每次请求间的节流延迟（毫秒） */
const THROTTLE_DELAY_MS = 300;
/** 登录后首次执行化肥任务的延迟（毫秒） */
const INITIAL_DELAY_MS = 15000;
/** 定期执行化肥任务的默认间隔（毫秒） */
const DEFAULT_FERTILIZER_INTERVAL_MS = 3600000; // 1小时

// ============ 化肥相关物品 ID ============

/** 化肥礼包 ID 集合 (type=11, can_use=1) */
const FERTILIZER_PACK_IDS = new Set([
    100003, // 化肥礼包
    100004, // 有机化肥礼包
]);

/**
 * 化肥道具 ID 集合 (type=7, interaction_type='fertilizer'/'fertilizerpro')
 * 使用后填充对应化肥容器的时间
 */
const FERTILIZER_ITEM_IDS = new Set([
    80001, // 化肥(1小时)
    80002, // 化肥(4小时)
    80003, // 化肥(8小时)
    80004, // 化肥(12小时)
    80011, // 有机化肥(1小时)
    80012, // 有机化肥(4小时)
    80013, // 有机化肥(8小时)
    80014, // 有机化肥(12小时)
]);

// ============ 内部状态 ============

/** 当日已开启礼包数（进程生命周期内记录，按日期重置） */
let dailyPackOpened = 0;
let dailyPackDate = '';

/** 定时器 */
let fertilizerTimer = null;

// ============ 协议函数 ============

/**
 * 单个物品 Use（逐个使用，支持 land_ids）
 * @param {number} itemId
 * @param {number} count
 * @returns {Promise<object>} UseReply
 */
async function useItem(itemId, count) {
    const body = types.UseRequest.encode(types.UseRequest.create({
        item_id: toLong(itemId),
        count: toLong(count),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return types.UseReply.decode(replyBody);
}

/**
 * 批量使用多种物品（BatchUse）
 * @param {Array<{item_id: number, count: number}>} items
 * @returns {Promise<object>} BatchUseReply
 */
async function batchUseItems(items) {
    const payload = items.map(it => ({
        item_id: toLong(it.item_id),
        count: toLong(it.count),
    }));
    const body = types.BatchUseRequest.encode(types.BatchUseRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', body);
    return types.BatchUseReply.decode(replyBody);
}

// ============ 核心逻辑 ============

/**
 * 重置每日计数（按日期检查）
 */
function resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (dailyPackDate !== today) {
        dailyPackDate = today;
        dailyPackOpened = 0;
    }
}

/**
 * 开启背包中的化肥礼包
 * 优先批量使用；失败时回退到逐个使用（每次 sleep 300ms 节流）
 * @param {Array} bagItems - getBagItems() 返回的背包物品列表
 * @returns {Promise<number>} 本次开启的礼包总数
 */
async function openFertilizerPacks(bagItems) {
    resetDailyIfNeeded();

    const dailyLimit = CONFIG.fertilizerPackDailyLimit;
    const packs = [];

    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_PACK_IDS.has(id) && count > 0) {
            let toOpen = count;
            if (dailyLimit > 0) {
                const remaining = dailyLimit - dailyPackOpened;
                if (remaining <= 0) {
                    log('化肥', `今日礼包开启已达上限 (${dailyLimit})，跳过`);
                    continue;
                }
                toOpen = Math.min(count, remaining);
            }
            packs.push({ item_id: id, count: toOpen });
        }
    }

    if (packs.length === 0) return 0;

    const names = packs.map(p => {
        const name = p.item_id === 100003 ? '化肥礼包' : '有机化肥礼包';
        return `${name}x${p.count}`;
    });

    let totalOpened = 0;

    // 优先批量使用
    try {
        await batchUseItems(packs);
        totalOpened = packs.reduce((s, p) => s + p.count, 0);
        dailyPackOpened += totalOpened;
        log('化肥', `批量开启礼包: ${names.join(', ')}，共 ${totalOpened} 个`);
        return totalOpened;
    } catch (batchErr) {
        logWarn('化肥', `批量开启失败 (${batchErr.message})，回退到逐个开启`);
    }

    // 回退：逐个使用
    for (const pack of packs) {
        for (let i = 0; i < pack.count; i++) {
            if (dailyLimit > 0 && dailyPackOpened >= dailyLimit) break;
            try {
                await useItem(pack.item_id, 1);
                dailyPackOpened++;
                totalOpened++;
            } catch (e) {
                logWarn('化肥', `开启礼包 ${pack.item_id} 失败: ${e.message}`);
            }
            await sleep(THROTTLE_DELAY_MS);
        }
    }

    if (totalOpened > 0) {
        log('化肥', `逐个开启礼包完成，共 ${totalOpened} 个`);
    }
    return totalOpened;
}

/**
 * 使用多余的化肥道具（当道具总数 > 目标阈值时，使用多余部分以填充容器）
 * 优先批量使用；失败时回退到逐个使用（每次 sleep 300ms 节流）
 * @param {Array} bagItems - getBagItems() 返回的背包物品列表
 * @returns {Promise<number>} 本次使用的道具总数
 */
async function useSurplusFertilizerItems(bagItems) {
    const targetCount = CONFIG.fertilizerTargetCount;

    // 计算背包中化肥道具总数与各种明细
    const itemMap = new Map(); // item_id -> count
    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_ITEM_IDS.has(id) && count > 0) {
            itemMap.set(id, (itemMap.get(id) || 0) + count);
        }
    }

    const totalItems = [...itemMap.values()].reduce((s, c) => s + c, 0);
    if (totalItems <= targetCount) {
        if (totalItems > 0) {
            log('化肥', `道具总数 ${totalItems}，不超过目标 ${targetCount}，无需使用`);
        }
        return 0;
    }

    const surplus = totalItems - targetCount;
    log('化肥', `道具总数 ${totalItems}，超出目标 ${targetCount}，将使用 ${surplus} 个`);

    // 构建要使用的列表（从数量最多的先消耗，保持均衡）
    let remaining = surplus;
    const toUse = [];
    for (const [id, count] of [...itemMap.entries()].sort((a, b) => b[1] - a[1])) {
        if (remaining <= 0) break;
        const use = Math.min(count, remaining);
        toUse.push({ item_id: id, count: use });
        remaining -= use;
    }

    const names = toUse.map(t => {
        const hours = getItemHours(t.item_id);
        const type = t.item_id >= 80011 ? '有机化肥' : '化肥';
        return `${type}(${hours}h)x${t.count}`;
    });

    let totalUsed = 0;

    // 优先批量使用
    try {
        await batchUseItems(toUse);
        totalUsed = toUse.reduce((s, t) => s + t.count, 0);
        log('化肥', `批量使用道具: ${names.join(', ')}，共 ${totalUsed} 个`);
        return totalUsed;
    } catch (batchErr) {
        logWarn('化肥', `批量使用道具失败 (${batchErr.message})，回退到逐个使用`);
    }

    // 回退：逐个使用
    for (const t of toUse) {
        for (let i = 0; i < t.count; i++) {
            try {
                await useItem(t.item_id, 1);
                totalUsed++;
            } catch (e) {
                logWarn('化肥', `使用道具 ${t.item_id} 失败: ${e.message}`);
            }
            await sleep(THROTTLE_DELAY_MS);
        }
    }

    if (totalUsed > 0) {
        log('化肥', `逐个使用道具完成，共 ${totalUsed} 个`);
    }
    return totalUsed;
}

/**
 * 从物品 ID 推断小时数（仅用于日志）
 */
function getItemHours(itemId) {
    const map = { 80001: 1, 80002: 4, 80003: 8, 80004: 12, 80011: 1, 80012: 4, 80013: 8, 80014: 12 };
    return map[itemId] || '?';
}

// ============ 对外主入口 ============

/**
 * 执行一次化肥自动化任务（开礼包 → 使用多余道具）
 * 异常全部捕获，不中断主流程。
 */
async function runFertilizerTask() {
    if (!CONFIG.autoUseFertilizer) return;

    try {
        const bagReply = await getBag();
        const items = getBagItems(bagReply);

        const packsOpened = await openFertilizerPacks(items);

        // 若开了礼包，重新获取背包以拿到最新道具数量
        let latestItems = items;
        if (packsOpened > 0) {
            try {
                const freshBag = await getBag();
                latestItems = getBagItems(freshBag);
            } catch (e) {
                logWarn('化肥', `刷新背包失败: ${e.message}，使用旧数据继续`);
            }
        }

        await useSurplusFertilizerItems(latestItems);
    } catch (e) {
        logWarn('化肥', `化肥任务异常: ${e.message}`);
    }
}

/**
 * 启动定期化肥任务定时器
 * @param {number} intervalMs - 间隔毫秒数（默认 1 小时）
 */
function startFertilizerLoop(intervalMs = DEFAULT_FERTILIZER_INTERVAL_MS) {
    if (!CONFIG.autoUseFertilizer) return;
    if (fertilizerTimer) return;

    // 延迟首次执行（等登录流程稳定）
    setTimeout(() => {
        runFertilizerTask();
        fertilizerTimer = setInterval(() => runFertilizerTask(), intervalMs);
    }, INITIAL_DELAY_MS);
}

/**
 * 停止定期化肥任务定时器
 */
function stopFertilizerLoop() {
    if (fertilizerTimer) {
        clearInterval(fertilizerTimer);
        fertilizerTimer = null;
    }
}

// ============ 纯函数（可单独测试）============

/**
 * 从背包物品列表中识别化肥礼包
 * @param {Array} bagItems
 * @returns {Array<{id: number, count: number}>}
 */
function identifyFertilizerPacks(bagItems) {
    const result = [];
    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_PACK_IDS.has(id) && count > 0) {
            result.push({ id, count });
        }
    }
    return result;
}

/**
 * 从背包物品列表中识别化肥道具并计算超出阈值的用量
 * @param {Array} bagItems
 * @param {number} targetCount
 * @returns {{ total: number, surplus: number, toUse: Array<{item_id: number, count: number}> }}
 */
function calcFertilizerItemUsage(bagItems, targetCount) {
    const itemMap = new Map();
    for (const item of bagItems) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (FERTILIZER_ITEM_IDS.has(id) && count > 0) {
            itemMap.set(id, (itemMap.get(id) || 0) + count);
        }
    }

    const total = [...itemMap.values()].reduce((s, c) => s + c, 0);
    const surplus = Math.max(0, total - targetCount);
    const toUse = [];

    if (surplus > 0) {
        let remaining = surplus;
        for (const [id, count] of [...itemMap.entries()].sort((a, b) => b[1] - a[1])) {
            if (remaining <= 0) break;
            const use = Math.min(count, remaining);
            toUse.push({ item_id: id, count: use });
            remaining -= use;
        }
    }

    return { total, surplus, toUse };
}

module.exports = {
    runFertilizerTask,
    startFertilizerLoop,
    stopFertilizerLoop,
    // 纯函数（测试/调试用）
    identifyFertilizerPacks,
    calcFertilizerItemUsage,
    FERTILIZER_PACK_IDS,
    FERTILIZER_ITEM_IDS,
};
