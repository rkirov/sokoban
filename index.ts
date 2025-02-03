import * as fs from 'fs';
import { Heap } from './heap';

type Grid = string[];
type Pos = [number, number];

enum Dir {
    Up,
    Left,
    Down,
    Right
}

/**
 * Maximum size of the grid that we can handle.
 * Mostly due to precomputing moves to nearest grid. It is possible to increase this limit, but all
 * microban levels are within this limit.
 */
const MAX_SIZE = 50;
/**
 * Whether to use hungarian matching for heuristic calculation for A* search, or a simpler heuristic.
 */
const USE_HUNGARIAN = false;
/**
 * Maximum number of states to visit before giving up.
 */
const MAX_SEARCH = 300_000;

let ZORBIST_CRATES = new Map<string, number>();
let ZORBIST_PLAYER = new Map<string, number>();

// TODO: at what size and number of crates do collisions start to happen?
function initZorbist() {
    for (let i = 0; i < MAX_SIZE; i++) {
        for (let j = 0; j < MAX_SIZE; j++) {
            ZORBIST_CRATES.set(i + ',' + j, Math.floor(Math.random() * (1 << 30)));
            ZORBIST_PLAYER.set(i + ',' + j, Math.floor(Math.random() * (1 << 30)));
        }
    }
}
initZorbist();


class Level {
    checkSize() {
        let l = this.grid.length;
        let w = Math.max(...this.grid.map(row => row.length));
        if (l > MAX_SIZE || w > MAX_SIZE) {
            throw new Error(`Grid size too large: ${l}x${w}, max is ${MAX_SIZE}x${MAX_SIZE}`);
        }
    }

    moveCreate(crateIndex: number, dir: Dir) {
        let crate = this.crates[crateIndex];
        let key = crate[0] + ',' + crate[1];
        this.hash ^= ZORBIST_CRATES.get(key)!;

        let nextPos = move(crate[0], crate[1], dir);
        let nextKey = nextPos[0] + ',' + nextPos[1];
        this.hash ^= ZORBIST_CRATES.get(nextKey)!;

        this.crates[crateIndex] = nextPos;
    }

    getCreate(crateIndex: number) {
        return this.crates[crateIndex];
    }

    addCrate(crate: Pos) {
        this.crates.push(crate);
        this.hash ^= ZORBIST_CRATES.get(crate[0] + ',' + crate[1])!;
    }

    * cratesIter(): IterableIterator<Pos> {
        for (let c of this.crates) {
            yield c;
        }
    }

    updateHeuristicSimple() {
        let h = 0;
        // simple heuristic, sum of moves to nearest grid for each crate
        for (let i = 0; i < this.crates.length; i++) {
            let crate = this.crates[i];
            h += this.movesCountToNearestGrid[i].get(crate[0] + ',' + crate[1])!;
        }
        this.heuristic = h;
    }

    updateHeuristic() {
        if (USE_HUNGARIAN) {
            this.updateHeuristicHungarian();
        } else {
            this.updateHeuristicSimple();
        }
    }

    // hungarian matching
    // https://en.wikipedia.org/wiki/Hungarian_algorithm
    updateHeuristicHungarian() {
        let h = 0;
        let n = this.crates.length;
        let a = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                a[i][j] = this.movesCountToNearestGrid[i].get(this.crates[j][0] + ',' + this.crates[j][1])!;
            }
        }
        let u = Array.from({ length: n }, () => 0);
        let v = Array.from({ length: n }, () => 0);
        let p = Array.from({ length: n }, () => 0);
        let way = Array.from({ length: n }, () => 0);
        for (let i = 0; i < n; i++) {
            p[0] = i;
            let j0 = 0;
            let minv = Array.from({ length: n }, () => Infinity);
            let used = Array.from({ length: n }, () => false);
            do {
                used[j0] = true;
                let i0 = p[j0];
                let delta = Infinity;
                let j1 = 0;
                for (let j = 0; j < n; j++) {
                    if (!used[j]) {
                        let cur = a[i0][j] - u[i0] - v[j];
                        if (cur < minv[j]) {
                            minv[j] = cur;
                            way[j] = j0;
                        }
                        if (minv[j] < delta) {
                            delta = minv[j];
                            j1 = j;
                        }
                    }
                }
                for (let j = 0; j < n; j++) {
                    if (used[j]) {
                        u[p[j]] += delta;
                        v[j] -= delta;
                    } else {
                        minv[j] -= delta;
                    }
                }
                j0 = j1;
            } while (p[j0] !== 0);
            do {
                let j1 = way[j0];
                p[j0] = p[j1];
                j0 = j1;
            } while (j0 !== 0);
        }
        for (let i = 0; i < n; i++) {
            h += a[p[i]][i];
        }
        this.heuristic = h;
    }


    // immutable fields, stay constant throughout the search

    // mutable fields
    player: Pos = [0, 0];
    private crates: Pos[] = [];
    hash: number = 0;
    heuristic: number = 0;
    topReachable: Pos | null = null;

    constructor(
        public name: string,
        private grid: Grid,
        public movesCountToNearestGrid: Map<string, number>[],
        public goals: Pos[],
        public deadEnds: Set<string>,
        public reachablePositions: Set<string>,
        public reachablePositionsFromCrates: Set<string>[],
        public cuts: Map<string, Dir[]>) {
    }

    clone(): Level {
        let l = new Level(
            this.name, this.grid, this.movesCountToNearestGrid, this.goals, this.deadEnds,
            this.reachablePositions, this.reachablePositionsFromCrates, this.cuts);
        l.hash = this.hash;
        if (this.topReachable) {
            l.hash ^= ZORBIST_PLAYER.get(this.topReachable![0] + ',' + this.topReachable![1])!;
        }
        l.crates = this.crates.slice();
        return l;
    }

    isSolved(): boolean {
        return this.crates.every(crate => this.grid[crate[0]][crate[1]] === '.');
    }

    isBlocked(pos: Pos): boolean {
        return this.isWall(pos) || this.isCrate(pos);
    }

    isInGrid(pos: Pos): boolean {
        return pos[0] >= 0 && pos[0] < this.grid.length && pos[1] >= 0 && pos[1] < this.grid[pos[0]].length;
    }

    isGoal(pos: Pos): boolean {
        return this.grid[pos[0]][pos[1]] === '.';
    }

    isWall(pos: Pos): boolean {
        return this.grid[pos[0]][pos[1]] === '#';
    }

    isCrate(pos: Pos): boolean {
        return this.crates.some(crate => crate[0] === pos[0] && crate[1] === pos[1]);
    }

    createIndex(pos: Pos): number {
        return this.crates.findIndex(c => c[0] === pos[0] && c[1] === pos[1]);
    }

    addLine(line: string) {
        this.grid.push(line);
    }

    length() {
        return this.grid.length;
    }

    printLevel() {
        let level = this;
        let grid = level.grid.map(row => row.split(''));
        grid[level.player[0]][level.player[1]] = '@';
        for (let crate of level.crates) {
            grid[crate[0]][crate[1]] = '$';
        }
        for (let goal of level.goals) {
            if (grid[goal[0]][goal[1]] === '$') {
                grid[goal[0]][goal[1]] = '*';
            } else if (grid[goal[0]][goal[1]] === '@') {
                grid[goal[0]][goal[1]] = '+';
            } else {
                grid[goal[0]][goal[1]] = '.';
            }
        }
        // add top reachable
        if (level.topReachable) {
            grid[level.topReachable[0]][level.topReachable[1]] = 'T';
        }
        for (let row of grid) {
            console.log(row.join(''));
        }
        console.log(`hash: ${level.hash}`);
    }

    printPrecomputed() {
        let level = this;
        let grid = level.grid.map(row => row.split(''));
        for (let deadEnd of level.deadEnds) {
            let [x, y] = deadEnd.split(',').map(Number) as Pos;
            grid[x][y] = 'X';
        }
        for (let cut of level.cuts.keys()) {
            let [x, y] = cut.split(',').map(Number) as Pos;
            let dirs = level.cuts.get(cut)!;
            grid[x][y] = dirs.length + '';
        }
        for (let row of grid) {
            console.log(row.join(''));
        }
    }

    printMoveCounts() {
        let idx = 0;
        for (let m of this.movesCountToNearestGrid) {
            console.log(`Moves to nearest grid for crate ${idx++}`);
            let grid = this.grid.map(row => row.split(''));

            for (let [k, v] of m) {
                let [x, y] = k.split(',').map(Number) as Pos;
                grid[x][y] = v + '';
            }
            for (let row of grid) {
                console.log(row.join(''));
            }
        }

    }

    printStats() {
        console.log(`Stats: Crates=${this.crates.length} Reachable States=${this.reachablePositions.size} Dead Ends=${this.deadEnds.size} Cuts=${this.cuts.size}`);
    }
}

function nextDir(d: Dir): Dir {
    return (d + 1) % 4;
}

function prevDir(d: Dir): Dir {
    return (d + 3) % 4;
}

function tryMove(level: Level, crateIndex: number, dir: Dir): Level | null {
    let crate = level.getCreate(crateIndex);
    let nextPos = move(crate[0], crate[1], dir);
    if (level.isBlocked(nextPos)) {
        return null;
    }
    let key = nextPos[0] + ',' + nextPos[1];
    if (level.deadEnds.has(key)) {
        return null;
    }

    // check for forbidden patterns
    // e.g.
    // 
    // XX
    // $$
    let neighborWalls = [];
    let neighborCrates = [];
    for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
        let n = move(nextPos[0], nextPos[1], d);
        if (level.isWall(n)) {
            neighborWalls.push(d);
        }
        if (level.isCrate(n)) {
            // don't count original
            if (n[0] === crate[0] && n[1] === crate[1]) {
                continue;
            }
            neighborCrates.push(d);
        }
    }
    // 2n
    // 43
    // either 2 or 3 has to a create, otherwise it's already a dead end
    for (let d of neighborCrates) {
        let p2 = move(nextPos[0], nextPos[1], d);
        for (let nd of [nextDir(d), prevDir(d)]) {
            if (neighborCrates.includes(nd) || neighborWalls.includes(nd)) {
                let forthcell = move(p2[0], p2[1], nd);
                if (level.isWall(forthcell) || level.isCrate(forthcell)) {
                    // finally make sure at least one of the crate is not on a goal
                    if (!level.isGoal(nextPos) || !level.isGoal(p2)) {
                        return null;
                    }
                }
            }
        }
    }


    let newLevel: Level = level.clone();
    newLevel.player = crate;
    newLevel.topReachable = null;
    newLevel.moveCreate(crateIndex, dir);
    newLevel.updateHeuristic();
    return newLevel;
}

/**
 * Returns a list of possible moves for the crates as index and direction.
 * 
 * And update the topReachable position.
 */
function possibleCrateMoves(level: Level): [number, Dir][] {
    let queue: Pos[] = [level.player];
    let moves: [number, Dir][] = [];
    let visited = new Set<string>();
    while (queue.length > 0) {
        let pos = queue.shift()!;
        let [x, y] = pos;
        if (!level.topReachable || x < level.topReachable[0] || (x === level.topReachable[0] && y < level.topReachable[1])) {
            level.topReachable = pos;
        }
        // check if we can move the crate in any direction
        for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
            let nextPos = move(x, y, d);
            if (!level.isInGrid(nextPos)) {
                continue;
            }
            let crateIndex = level.createIndex(nextPos);
            if (crateIndex === -1) {
                continue;
            }
            moves.push([crateIndex, d]);
        }
        for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
            let nextPos = move(x, y, d);
            if (!level.isInGrid(nextPos)) {
                continue;
            }
            if (level.isBlocked(nextPos)) {
                continue;
            }
            let key = nextPos[0] + ',' + nextPos[1];
            if (visited.has(key)) {
                continue;
            }
            visited.add(key);
            queue.push(nextPos);
        }
    }
    return moves;
}

function oppositeDir(d: Dir): Dir {
    return (d + 2) % 4;
}

function move(i: number, j: number, dir: Dir): Pos {
    switch (dir) {
        case Dir.Up:
            return [i - 1, j];
        case Dir.Down:
            return [i + 1, j];
        case Dir.Left:
            return [i, j - 1];
        case Dir.Right:
            return [i, j + 1];
    }
}

function precompute(level: Level) {
    level.reachablePositions = computerReachablePositions(level);
    level.reachablePositionsFromCrates = computerCreateReachablePositions(level);
    level.movesCountToNearestGrid = computeMovesCount(level);
    level.deadEnds = computeDeadEnds(level);
    level.cuts = computeCuts(level);
}

/**
 * For each create, computes the set of reachable positions from its starting position.
 * 
 * Assume all other crates are out of the way.
 */

function computerCreateReachablePositions(level: Level): Set<string>[] {
    let reachablePositions: Set<string>[] = [];
    for (let c of level.cratesIter()) {
        let queue: Pos[] = [c];
        let reachable = new Set<string>();
        while (queue.length > 0) {
            let pos = queue.shift()!;
            let [x, y] = pos;
            if (reachable.has(x + ',' + y)) {
                continue;
            }
            reachable.add(x + ',' + y);
            for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {

                let nextPos = move(x, y, d);
                if (!level.isInGrid(nextPos)) continue;
                if (level.isWall(nextPos)) continue;
                let behindPos = move(x, y, oppositeDir(d));
                if (level.isWall(behindPos)) continue;
                queue.push(nextPos);
            }
        }
        reachablePositions.push(reachable);
    }
    return reachablePositions;
}


/**
 * Compute the set of reachable positions from the player position.
 */
function computerReachablePositions(level: Level): Set<string> {
    let reachablePositions = new Set<string>();
    let queue: Pos[] = [level.player];
    while (queue.length > 0) {
        let pos = queue.shift()!;
        let [x, y] = pos;
        if (reachablePositions.has(x + ',' + y)) {
            continue;
        }
        reachablePositions.add(x + ',' + y);
        for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
            let nextPos = move(x, y, d);
            if (!level.isInGrid(nextPos)) continue;
            if (level.isWall(nextPos)) continue;
            queue.push(nextPos);
        }
    }
    return reachablePositions;
}

/**
 * Precomputes for each reachable position what's the number of moves to reach the nearest grid position.
 * Stores it in a map from position to number of moves.
 */
function computeMovesCount(level: Level): Map<string, number>[] {
    let a = [];
    for (let crate of level.cratesIter()) {
        let m = new Map<string, number>();
        for (let start of level.reachablePositionsFromCrates[level.createIndex(crate)]) {
            let queue: [Pos, number][] = [[start.split(',').map(Number) as Pos, 0]];
            let visited = new Set<string>();
            while (queue.length > 0) {
                let [pos, count] = queue.shift()!;
                let key = pos[0] + ',' + pos[1];
                if (visited.has(key)) {
                    continue;
                }
                visited.add(key);
                if (level.isGoal(pos) && !m.has(start)) {
                    // could add key later to track the goal position
                    m.set(start, count);
                    break;
                }
                for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
                    let nextPos = move(pos[0], pos[1], d);
                    if (!level.isInGrid(nextPos)) continue;
                    if (level.isWall(nextPos)) continue;
                    let backPos = move(pos[0], pos[1], oppositeDir(d));
                    if (level.isWall(backPos)) continue;
                    queue.push([nextPos, count + 1]);
                }
            }
        }
        a.push(m);
    }
    return a;
}

/**
 * Returns a list of dead ends in the level
 * Dead end is a position such that if a crate is pushed there, it's impossible to move it out.
 * 
 * examples of a dead end:
 * 
 * #####
 * # $ #
 *  
 * ##
 * #$
 * 
 */
function computeDeadEnds(level: Level): Set<string> {
    let deadEnds = new Set<string>();
    for (let start of level.reachablePositions) {
        let [x, y] = start.split(',').map(Number) as Pos;
        // goals are not dead ends
        if (level.isGoal([x, y])) {
            continue;
        }
        let dirsToWall = [];
        for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
            let n = move(x, y, d);
            if (level.isWall(n)) {
                dirsToWall.push(d);
            }
        }
        if (dirsToWall.length === 0) {
            continue;
        }
        if (dirsToWall.length > 2) {
            deadEnds.add(x + ',' + y);
            continue;
        }
        if (dirsToWall.length === 2) {
            // check if blocks bot horizontal and vertical movement
            let [d1, d2] = dirsToWall;
            if ((d1 - d2) % 2 != 0) {
                deadEnds.add(x + ',' + y);
                continue;
            }
        }
        let d = dirsToWall[0];
        let otherDirs = d == Dir.Up || d == Dir.Down ? [Dir.Left, Dir.Right] : [Dir.Up, Dir.Down];
        // go left and right until #
        let good = true;
        for (let otherDir of otherDirs) {
            let next = move(x, y, otherDir);
            while (!level.isWall(next)) {
                if (level.isGoal(next)) {
                    good = false;
                    break;
                }
                // all of next should also be next to a wall
                let sameDir = move(next[0], next[1], d);
                if (!level.isWall(sameDir)) {
                    good = false;
                    break;
                }
                next = move(next[0], next[1], otherDir);
            }
        }
        if (good) {
            deadEnds.add(x + ',' + y);
        }
    }
    return deadEnds;
}

function computeCuts(level: Level): Map<string, Dir[]> {
    let time = 0;
    let low = new Map<string, number>();
    let disc = new Map<string, number>();
    let cuts = new Map<string, Dir[]>();

    // tarjan's algorithm
    function dfs(n: Pos, parent: Pos | null) {
        let childrenCount = 0;
        let key = n[0] + ',' + n[1];
        disc.set(key, time);
        low.set(key, time);
        time++;
        for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
            let next = move(n[0], n[1], d);
            if (!level.isInGrid(next)) continue;
            if (level.isWall(next)) continue;
            let keyNext = next[0] + ',' + next[1];
            if (!disc.has(keyNext)) {
                dfs(next, n);
                low.set(key, Math.min(low.get(key)!, low.get(keyNext)!));
                if (low.get(keyNext)! >= disc.get(key)! && parent !== null) {
                    cuts.set(key, []);
                }
                childrenCount++;
            } else if (parent && keyNext !== parent[0] + ',' + parent[1]) {
                low.set(key, Math.min(low.get(key)!, disc.get(keyNext)!));
            }
        }
        if (parent === null && childrenCount > 1) {
            cuts.set(key, []);
        }
    }
    dfs(level.player, null);

    for (let [c, v] of cuts) {
        // calculate the direction of the cut which have a goal
        let [x, y] = c.split(',').map(Number) as Pos;
        for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
            // run bfs to see if we can reach a goal
            let visited = new Set<string>();
            function dfs(n: Pos) {
                let key = n[0] + ',' + n[1];
                if (visited.has(key)) {
                    return;
                }
                if (!level.isInGrid(n)) {
                    return;
                }
                if (level.isWall(n) || n[0] === x && n[1] === y) {
                    return;
                }
                visited.add(key);
                if (level.isGoal(n)) {
                    if (!v.includes(d)) {
                        v.push(d);
                    }
                    return;
                }
                for (let d of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
                    dfs(move(n[0], n[1], d));
                }
            }
            dfs(move(x, y, d));
        }
    }
    return cuts;
}

function parseFile(): Level[] {
    let data = fs.readFileSync(0, 'utf8');
    let lines = data.split('\n');
    let levels: Level[] = [];
    let level: Level | null = null;
    for (let line of lines) {
        if (line === '') continue;
        if (line.startsWith(';')) {
            let name = line.substring(1).trim();
            if (level) {
                precompute(level);
                levels.push(level);
            }
            level = new Level(name, [], [], [], new Set(), new Set(), [], new Map());
        } else if (level) {
            for (let i = 0; i < line.length; i++) {
                let c = line[i];
                let l = level.length();
                if (c === '@') {
                    level.player = [l, i];
                } else if (c === '+') {
                    level.player = [l, i];
                    level.goals.push([l, i]);
                } else if (c === '.') {
                    level.goals.push([l, i]);
                } else if (c === '$') {
                    level.addCrate([l, i]);
                } else if (c === '*') {
                    level.goals.push([l, i]);
                    level.addCrate([l, i]);
                }
                // remove crates and player from grid
                if (c === '@' || c === '$' || c === '*' || c === '+') {
                    let newC = ' ';
                    if (c === '*' || c === '+') {
                        newC = '.';
                    }
                    line = line.substring(0, i) + newC + line.substring(i + 1);
                }
            }
            level.addLine(line);
        }
    }

    if (level) {
        level.checkSize();
        precompute(level);
        levels.push(level);
    }
    return levels;
}

interface State {
    level: Level;
    moves: [number, Dir][];
}


function search(level: Level) {
    let queue = new Heap<State>((a, b) => a.moves.length + a.level.heuristic - b.moves.length - b.level.heuristic);
    queue.push({ level, moves: [] });
    let visited = new Set<number>();
    while (queue.length > 0) {
        if (visited.size > MAX_SEARCH) {
            console.log('Exception: Too many states visited');
            return [];
        }
        let s = queue.pop()!;
        let level = s.level;
        if (level.isSolved()) {
            console.log(`Solved in ${s.moves.length} moves. States visited: ${visited.size}`);
            return s.moves;
        }
        let moves = possibleCrateMoves(level);
        level.hash ^= ZORBIST_PLAYER.get(level.topReachable![0] + ',' + level.topReachable![1])!;

        // need to happen after possibleCrateMoves because it sets topReachable
        if (visited.has(level.hash)) {
            continue;
        }
        visited.add(level.hash);
        for (let [crateIdx, dir] of moves) {
            let moves: [number, Dir][] = [[crateIdx, dir]];
            let newLevel = tryMove(level, crateIdx, dir);
            // if crate is on a cut node and we are surrounded by walls, and not a goal
            // repeatedly move the create
            if (!newLevel) continue;
            let newCratePos = newLevel.getCreate(crateIdx);
            while (level.cuts.has(newCratePos[0] + ',' + newCratePos[1]) && !level.isGoal(newCratePos)) {
                if (!level.isWall(move(newCratePos[0], newCratePos[1], nextDir(dir))) ||
                    !level.isWall(move(newCratePos[0], newCratePos[1], prevDir(dir)))) {
                    break;
                }

                let newNewLevel = tryMove(newLevel, crateIdx, dir);
                if (!newNewLevel) {
                    break;
                }
                moves.push([crateIdx, dir]);
                newLevel = newNewLevel;
                newCratePos = newLevel.getCreate(crateIdx);
            }
            queue.push({ level: newLevel, moves: s.moves.concat(moves) });
        }
    }
    throw new Error(`No solution found after visiting ${visited.size} states`);
}

function verifyMoves(level: Level, moves: [number, Dir][]) {
    for (let [crateIdx, dir] of moves) {
        let newLevel = tryMove(level, crateIdx, dir)
        if (!newLevel) {
            throw new Error('Invalid move');
        }
        level = newLevel;
    }
    if (!level.isSolved()) {
        throw new Error('Incorrect solution');
    }
}

let levels = parseFile();
let start = Date.now();
let skipped: string[] = [];
for (let level of levels) {
    console.log(level.name);
    level.printPrecomputed();

    level.printLevel();
    level.printStats();
    let levelStart = Date.now();
    console.log('Global time (in sec): ', (Date.now() - start) / 1000);
    let moves = search(level);
    console.log('Solved in time (in sec): ', (Date.now() - levelStart) / 1000, 'Global time (in sec): ', (Date.now() - start) / 1000);
    if (moves.length === 0) {
        skipped.push(level.name);
    } else {
        verifyMoves(level, moves);
    }
}
let skippedCount = skipped.length;
console.log(`Levels solved: ${levels.length - skippedCount} Levels skipped: ${skippedCount} Total levels: ${levels.length}`);
console.log('Skipped levels: ', skipped.join(', '));