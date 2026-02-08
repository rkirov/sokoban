# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Compile TypeScript
tsc

# Run solver on a level pack
node index.js < levels/microban1.txt

# Run on specific level file
node index.js < levels/xsokoban.txt
```

No test framework is configured. No linting setup exists.

## Architecture

This is a Sokoban puzzle solver using A* search with Zobrist hashing.

### Core Components

**Level class** (`index.ts`): Represents puzzle state with grid, player position, and crate positions. Contains both mutable search state (player, crates, hash, heuristic) and immutable precomputed data (goals, deadEnds, reachablePositions, movesCountToNearestGrid, cuts).

**Heap** (`heap.ts`): Generic min-heap priority queue for A* search, ordering states by `g + h` (cost + heuristic).

**Zobrist hashing**: XOR-based incremental hashing for fast duplicate state detection. Two maps: `ZORBIST_CRATES` and `ZORBIST_PLAYER`.

### Search Flow

1. **Parse level** from stdin (supports RLE-like format with `;` comments)
2. **Precompute** dead ends, cuts (articulation points), reachable positions, move distances
3. **A* search**: BFS from player to find pushable crates → validate push with deadlock checks → update hash/heuristic
4. **Verify** solution correctness

### Key Constants

- `MAX_SIZE = 50`: Maximum grid dimension
- `HUNGARIAN_MAX_CRATES = 0`: Use Hungarian heuristic only for levels with <= N crates (0 = disabled, simple is faster on easy levels)
- `MAX_SEARCH = 300_000`: State limit before giving up

### Deadlock Detection

- **Dead ends**: Positions from which no goal is reachable (precomputed via reverse BFS from goals)
- **2x2 patterns**: Forbidden corner patterns where boxes get stuck
- **Freeze detection**: Boxes frozen on both axes that aren't on goals

### Level Format

Symbols: `#` (wall), `@` (player), `$` (crate), `.` (goal), `+` (player on goal), `*` (crate on goal)

Level packs in `levels/`: microban (beginner), sasquatch (medium), xsokoban (hard, 90 levels), boxoban-hard (extreme)

## Current Capabilities

Solves 151/155 Microban1 levels in ~170 seconds. Struggles with hard puzzles (xsokoban) due to state explosion. See PLAN.md for improvement roadmap.

## Testing

Quick test suite for iteration: `node index.js < levels/test-quick.txt`

Contains 4 levels testing basic solving, freeze detection, and multi-box pushes.
