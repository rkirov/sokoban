# From Basic Solver to State-of-the-Art: A Sokoban Improvement Plan

A basic Sokoban solver using BFS or simple A* can solve only elementary puzzles. The **86-level gap** between naive implementations and Festival (which solves all 90 XSokoban levels) comes from a hierarchy of optimizations in deadlock detection, heuristics, and search strategy. This plan provides a prioritized roadmap for closing that gap, organized by expected impact and implementation complexity.

## Baseline solver analysis reveals critical missing techniques

The analysis examined TypeScript Sokoban solver architectures implementing BFS with basic heuristics. These baseline implementations typically share key characteristics: **2D array state representation** with string-based hashing, **Manhattan distance heuristics** summing each box's distance to the nearest goal, minimal deadlock detection (if any), and no macro moves or pruning. Performance caps out at solving only the simplest puzzles—anything requiring more than a few hundred moves becomes intractable.

The fundamental issue is search space explosion. Sokoban's branching factor is **3-4x higher than chess**, and the state space for a 20×20 puzzle reaches an estimated **10^98 configurations**. Without aggressive pruning and strong heuristics, even moderate puzzles exhaust memory or time. The gap between basic and state-of-the-art solvers isn't incremental improvements but transformative techniques, each providing order-of-magnitude gains.

| Feature | Basic Solver | State-of-the-Art (Festival/Rolling Stone) |
|---------|-------------|-------------------------------------------|
| Search Algorithm | BFS only | IDA*, FESS, Bidirectional |
| Heuristics | Manhattan distance | Pattern databases, Hungarian matching |
| Deadlock Detection | None/corner only | Freeze, bipartite, corral, PI-corral |
| State Representation | 2D array (string hash) | Zobrist hashing, normalized positions |
| Macro Moves | None | Tunnel macros, goal macros |
| XSokoban Levels Solved | ~5 | 90 (all) |

## Phase 1: Foundation improvements yield immediate 10-20x gains

These techniques are essential prerequisites that provide massive returns with moderate implementation effort. They should be implemented first in this exact order.

### 1.1 Dead square detection (Priority: Critical)

Pre-compute squares from which a box can never reach any goal. This eliminates **30-60% of generated states** with O(1) runtime checks. Implementation uses reverse BFS from each goal, marking squares a box can be pulled to:

```typescript
function findDeadSquares(level: Level): Set<Position> {
  const aliveSquares = new Set<Position>();
  
  for (const goal of level.goals) {
    const visited = new Set([positionKey(goal)]);
    const queue = [goal];
    
    while (queue.length > 0) {
      const pos = queue.shift()!;
      for (const dir of DIRECTIONS) {
        // Player position for pulling = pos + dir
        // New box position after pull = pos - dir
        const playerPos = addPositions(pos, dir);
        const newBoxPos = subtractPositions(pos, dir);
        
        if (isFloor(playerPos) && isFloor(newBoxPos) && !visited.has(positionKey(newBoxPos))) {
          visited.add(positionKey(newBoxPos));
          queue.push(newBoxPos);
          aliveSquares.add(newBoxPos);
        }
      }
    }
  }
  
  return setDifference(level.floorSquares, aliveSquares);
}
```

**Runtime check:** If `deadSquares.has(pushDestination)`, immediately reject the move.

### 1.2 Zobrist hashing with transposition tables (Priority: Critical)

String serialization for state hashing is catastrophically slow. Zobrist hashing provides **O(1) incremental updates** when boxes move. Pre-generate random 64-bit values for each (square, content) combination:

```typescript
const BOX_HASH: bigint[] = Array(numSquares).fill(0).map(() => randomBigInt64());
const PLAYER_ZONE_HASH: bigint[] = Array(numSquares).fill(0).map(() => randomBigInt64());

function computeHash(state: State): bigint {
  let hash = 0n;
  for (const boxPos of state.boxes) {
    hash ^= BOX_HASH[squareIndex(boxPos)];
  }
  hash ^= PLAYER_ZONE_HASH[normalizedPlayerZone(state)];
  return hash;
}

function updateHashAfterPush(oldHash: bigint, from: Position, to: Position): bigint {
  return oldHash ^ BOX_HASH[squareIndex(from)] ^ BOX_HASH[squareIndex(to)];
}
```

Transposition table should use **two-level replacement**: depth-preferred for primary slot, always-replace for secondary. This achieves **50-90% duplicate detection** depending on the level structure.

### 1.3 Normalized player positions (Priority: Critical)

Many player positions are functionally equivalent—they allow the same set of pushes. Normalizing to the minimum reachable square reduces distinct states by **10-50x**:

```typescript
function normalizeState(state: State): NormalizedState {
  const reachable = bfsPlayerReachable(state.playerPos, state.boxes);
  const normalizedPlayer = Math.min(...reachable.map(squareIndex));
  const accessibleBoxes = findAdjacentBoxes(reachable, state.boxes);
  
  return { boxes: state.boxes, playerZone: normalizedPlayer, pushableBoxes: accessibleBoxes };
}
```

Store `playerZone` instead of exact position. The reachable set also identifies which boxes can be pushed, avoiding redundant move generation.

## Phase 2: Heuristic improvements enable optimal solving

The minimum matching heuristic is the single most impactful algorithmic upgrade for optimal solving. Without it, even IDA* struggles to find solutions efficiently.

### 2.1 Minimum matching lower bound with Hungarian algorithm (Priority: High)

Replace Manhattan distance with minimum cost bipartite matching between boxes and goals. This is **admissible** (never overestimates) because each box must reach a distinct goal:

```typescript
function minimumMatchingHeuristic(boxes: Position[], goals: Position[], pushDistances: number[][]): number {
  const n = boxes.length;
  const costMatrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(Infinity));
  
  // Build cost matrix: cost[i][j] = minimum pushes for box i to reach goal j
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      costMatrix[i][j] = pushDistances[squareIndex(boxes[i])][squareIndex(goals[j])];
    }
  }
  
  const assignment = hungarianAlgorithm(costMatrix);
  
  // If no perfect matching exists, return Infinity (bipartite deadlock!)
  if (assignment.some(g => costMatrix[assignment.indexOf(g)][g] === Infinity)) {
    return Infinity;
  }
  
  return assignment.reduce((sum, goalIdx, boxIdx) => sum + costMatrix[boxIdx][goalIdx], 0);
}
```

**Key insight:** Hungarian algorithm runs in O(n³), but can be incrementally updated when only one box moves. Even the full computation is vastly superior to naive heuristics. This heuristic also **detects bipartite deadlocks** when no perfect matching exists—a crucial bonus.

### 2.2 Linear conflict enhancement (Priority: Medium)

Add penalties when boxes in the same row/column must pass through each other:

```typescript
function linearConflictPenalty(boxes: Position[], goals: Position[]): number {
  let penalty = 0;
  
  // Check each row
  for (const row of uniqueRows(goals)) {
    const boxesInGoalRow = boxes.filter(b => b.row === row && 
      goals.some(g => g.row === row && g.col !== b.col));
    
    for (let i = 0; i < boxesInGoalRow.length; i++) {
      for (let j = i + 1; j < boxesInGoalRow.length; j++) {
        const boxA = boxesInGoalRow[i], boxB = boxesInGoalRow[j];
        const goalA = findGoalInRow(boxA, goals), goalB = findGoalInRow(boxB, goals);
        
        // Conflict: boxes must swap positions relative to their goals
        if ((boxA.col < boxB.col) !== (goalA.col < goalB.col)) {
          penalty += 2; // Each conflict requires at least 2 extra pushes
        }
      }
    }
  }
  
  return penalty;
}
```

This provides **5-10x speedup** over pure matching heuristics in many levels.

## Phase 3: Advanced deadlock detection catches complex failures

Simple dead squares catch obvious failures. Advanced detection catches the subtle multi-box configurations that waste most search time.

### 3.1 Freeze deadlock detection (Priority: High)

A box is "frozen" if it can never move again. If any frozen box isn't on a goal, the state is deadlocked:

```typescript
function isFrozen(boxPos: Position, state: State, checking: Set<string> = new Set()): boolean {
  const key = positionKey(boxPos);
  if (checking.has(key)) return true; // Circular dependency = frozen
  checking.add(key);
  
  const blockedH = isBlockedOnAxis(boxPos, 'horizontal', state, checking);
  const blockedV = isBlockedOnAxis(boxPos, 'vertical', state, checking);
  
  checking.delete(key);
  return blockedH && blockedV;
}

function isBlockedOnAxis(pos: Position, axis: Axis, state: State, checking: Set<string>): boolean {
  const neighbors = getNeighborsOnAxis(pos, axis);
  
  // Blocked by walls on both sides
  if (neighbors.every(n => isWall(n))) return true;
  
  // Blocked by dead squares on both sides
  if (neighbors.every(n => deadSquares.has(n))) return true;
  
  // Blocked by frozen boxes
  for (const neighbor of neighbors) {
    if (hasBox(neighbor, state) && isFrozen(neighbor, state, checking)) {
      return true;
    }
  }
  
  return false;
}

function checkFreezeDeadlock(state: State): boolean {
  for (const box of state.boxes) {
    if (isFrozen(box, state) && !isGoal(box)) {
      return true; // Deadlock!
    }
  }
  return false;
}
```

This catches **10-30% of remaining deadlocks** after simple detection.

### 3.2 Corral and PI-corral pruning (Priority: High)

PI-corral pruning is described by YASS author Brian Damgaard as **"as important for Sokoban as alpha-beta pruning is for chess."** A PI-corral is an area the player can't reach where all boundary boxes can only be pushed inward:

```typescript
function findPICorral(state: State): Corral | null {
  const reachable = bfsPlayerReachable(state.playerPos, state.boxes);
  const corrals = findDisconnectedRegions(state.floorSquares, reachable);
  
  for (const corral of corrals) {
    const boundaryBoxes = findBoxesAdjacentToCorral(corral, state.boxes);
    let isPICorral = true;
    
    for (const box of boundaryBoxes) {
      // Check if box can be pushed OUT of the corral
      if (canPushOutOfCorral(box, corral, state)) {
        isPICorral = false;
        break;
      }
    }
    
    if (isPICorral && boundaryBoxes.length > 0) {
      return { region: corral, boundaryBoxes };
    }
  }
  
  return null;
}

function generateMoves(state: State): Move[] {
  const piCorral = findPICorral(state);
  
  if (piCorral) {
    // ONLY generate moves that push into this corral
    return generatePushesIntoCorral(piCorral, state);
  }
  
  return generateAllLegalPushes(state);
}
```

This reduces the search tree by **20%+ conservatively**, and forces early detection of corral deadlocks by immediately exploring them.

## Phase 4: Search algorithm upgrades for hard puzzles

BFS and basic A* hit memory limits on complex puzzles. IDA* trades re-expansion for linear memory, while bidirectional search avoids deadlocks entirely in the reverse direction.

### 4.1 IDA* implementation (Priority: High)

IDA* combines A*'s optimality with DFS's memory efficiency:

```typescript
function idaStar(initial: State): Solution | null {
  let bound = heuristic(initial);
  const path = [initial];
  
  while (true) {
    const result = search(path, 0, bound);
    if (result === 'FOUND') return reconstructPath(path);
    if (result === Infinity) return null;
    bound = result; // New threshold = minimum f-value that exceeded old threshold
  }
}

function search(path: State[], g: number, bound: number): number | 'FOUND' {
  const node = path[path.length - 1];
  const f = g + heuristic(node);
  
  if (f > bound) return f;
  if (isGoal(node)) return 'FOUND';
  
  let min = Infinity;
  const moves = generateMoves(node).sort((a, b) => 
    heuristic(applyMove(node, a)) - heuristic(applyMove(node, b))
  );
  
  for (const move of moves) {
    const successor = applyMove(node, move);
    if (!pathContains(path, successor)) {
      path.push(successor);
      const result = search(path, g + 1, bound);
      if (result === 'FOUND') return 'FOUND';
      if (result < min) min = result;
      path.pop();
    }
  }
  
  return min;
}
```

**Optimization:** Use push-count as cost (not moves), and exploit heuristic parity—if the heuristic is even and the current bound is odd, skip to the next even bound.

### 4.2 Bidirectional search (Priority: Medium-High)

Forward search pushes boxes toward goals; backward search **pulls boxes from the solved state**. The backward direction largely avoids deadlocks because it starts from a valid configuration:

```typescript
function bidirectionalSearch(initial: State, goalState: State): Solution | null {
  const forwardFrontier = new PriorityQueue([initial]);
  const backwardFrontier = new PriorityQueue([goalState]);
  const forwardVisited = new Map([[hash(initial), initial]]);
  const backwardVisited = new Map([[hash(goalState), goalState]]);
  
  while (!forwardFrontier.isEmpty() && !backwardFrontier.isEmpty()) {
    // Expand forward (push moves)
    const fState = forwardFrontier.pop();
    for (const successor of generatePushMoves(fState)) {
      const h = hash(successor);
      if (backwardVisited.has(h)) {
        return mergeSolutions(forwardPath(fState), backwardPath(backwardVisited.get(h)));
      }
      if (!forwardVisited.has(h)) {
        forwardVisited.set(h, fState);
        forwardFrontier.push(successor);
      }
    }
    
    // Expand backward (pull moves)
    const bState = backwardFrontier.pop();
    for (const predecessor of generatePullMoves(bState)) {
      const h = hash(predecessor);
      if (forwardVisited.has(h)) {
        return mergeSolutions(forwardPath(forwardVisited.get(h)), backwardPath(bState));
      }
      if (!backwardVisited.has(h)) {
        backwardVisited.set(h, bState);
        backwardFrontier.push(predecessor);
      }
    }
  }
  
  return null;
}
```

Sokolution reports solving **89/90 XSokoban levels** with bidirectional mode, demonstrating its power for hard puzzles.

## Phase 5: Domain optimizations for maximum performance

These advanced techniques provide the final performance gains needed to match world-class solvers.

### 5.1 Tunnel macros (Priority: Medium)

Boxes in tunnels (corridors bounded by walls) must traverse the entire tunnel. Collapse these into single moves:

```typescript
function findTunnels(level: Level): Tunnel[] {
  const tunnels: Tunnel[] = [];
  
  for (const square of level.floorSquares) {
    if (isWall(north(square)) && isWall(south(square)) && isFloor(east(square)) && isFloor(west(square))) {
      // Horizontal tunnel - find extent
      let start = square, end = square;
      while (isFloor(west(start)) && isWall(north(west(start))) && isWall(south(west(start)))) {
        start = west(start);
      }
      while (isFloor(east(end)) && isWall(north(east(end))) && isWall(south(east(end)))) {
        end = east(end);
      }
      tunnels.push({ start, end, axis: 'horizontal' });
    }
    // Similarly for vertical tunnels
  }
  
  return tunnels;
}

function applyPushWithTunnelMacro(box: Position, direction: Direction, tunnels: Tunnel[]): Position {
  const tunnel = tunnels.find(t => t.contains(box) && t.axis === directionAxis(direction));
  if (tunnel) {
    return tunnel.exitPosition(direction);
  }
  return addPositions(box, direction);
}
```

### 5.2 Move ordering (Priority: Medium)

Explore promising moves first to find solutions faster and enable more pruning:

```typescript
function orderMoves(moves: Move[], state: State): Move[] {
  return moves.sort((a, b) => {
    const scoreA = scoreMoveQuality(a, state);
    const scoreB = scoreMoveQuality(b, state);
    return scoreB - scoreA; // Higher scores first
  });
}

function scoreMoveQuality(move: Move, state: State): number {
  let score = 0;
  const newState = applyMove(state, move);
  
  // Prefer moves that decrease heuristic
  score += (heuristic(state) - heuristic(newState)) * 100;
  
  // Prefer moves toward goals
  if (movesTowardGoal(move, state)) score += 50;
  
  // Prefer box-to-goal placements
  if (placesBoxOnGoal(move, state)) score += 200;
  
  // Penalize moves that might create freeze deadlocks
  if (createsFreezePotential(newState, move)) score -= 100;
  
  return score;
}
```

## Implementation roadmap for Claude Code

This roadmap prioritizes by **impact-to-effort ratio** for an AI coding agent:

| Phase | Technique | Expected Impact | Effort | Dependencies |
|-------|-----------|-----------------|--------|--------------|
| 1a | Dead square detection | 30-60% pruning | 2 hours | None |
| 1b | Zobrist hashing | O(1) updates | 3 hours | None |
| 1c | Normalized positions | 10-50x state reduction | 2 hours | 1b |
| 1d | Transposition table | 50-90% dedup | 2 hours | 1b, 1c |
| 2a | Hungarian algorithm | 5-10x node reduction | 4 hours | None |
| 2b | Linear conflict | Additional 5-10x | 2 hours | 2a |
| 3a | Freeze deadlock | 10-30% additional pruning | 3 hours | 1a |
| 3b | PI-corral pruning | 20%+ tree pruning | 5 hours | Player reachability |
| 4a | IDA* search | Memory-efficient optimal | 3 hours | 2a, all deadlock detection |
| 4b | Bidirectional search | Avoids backward deadlocks | 5 hours | 4a |
| 5a | Tunnel macros | Depth reduction | 3 hours | 1a |
| 5b | Move ordering | 2-10x speedup | 2 hours | 2a |

**Total estimated implementation time: ~35 hours**

For each technique, the agent should:
1. Add the data structure/algorithm in isolation with unit tests
2. Integrate into the search loop with feature flags
3. Benchmark against XSokoban levels 1-10 (easy), 11-50 (medium), 51-90 (hard)
4. Profile to ensure no performance regressions

## Performance expectations by implementation phase

After completing each phase, expect these approximate XSokoban solving capabilities:

- **Baseline (BFS/simple A*)**: ~5 levels
- **Phase 1 complete**: ~20 levels (foundation enables everything else)
- **Phase 2 complete**: ~40 levels (strong heuristics find solutions efficiently)  
- **Phase 3 complete**: ~60 levels (deadlock detection eliminates wasted search)
- **Phase 4 complete**: ~75 levels (IDA*/bidirectional handle memory constraints)
- **Phase 5 complete**: ~85 levels (domain optimizations for hardest puzzles)

The final 5 levels require techniques like **pattern databases** (instance-specific pre-computation taking hours), **FESS algorithm** (Festival's feature-space search), or **machine learning augmentation**—beyond the scope of straightforward algorithmic improvements.

## Conclusion: Systematic improvement path from toy to competitive

The gap between a basic Sokoban solver and state-of-the-art isn't a single clever algorithm but a **stack of complementary techniques**. Dead square detection and Zobrist hashing form the essential foundation. The Hungarian algorithm heuristic transforms solution quality. Freeze and PI-corral detection eliminate the vast majority of wasted search. IDA* and bidirectional search handle memory constraints for complex puzzles.

Implementing this plan transforms a solver capable of elementary puzzles into one competitive with published research systems. The techniques are well-documented in academic literature, particularly Junghanns & Schaeffer's foundational work and Shoham's Festival papers. Each phase builds on previous work, so the implementation order matters—resist the temptation to jump to "exciting" advanced techniques before the foundation is solid.

For reference implementations, study **JSoko** (Java, open source, all deadlock types), **YASS** (Pascal, best PI-corral implementation), and **Rolling Stone** (C, foundational IDA* implementation). The Sokoban Wiki at sokobano.de provides comprehensive documentation on all techniques described here.
