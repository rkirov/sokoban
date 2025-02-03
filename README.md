# Sokoban solver

A simple Sokoban solver written in TypeScript.

## Levels

Level packs included from:

- [microban and sasquatch](http://www.abelmartin.com/rj/sokobanJS/Skinner/David%20W.%20Skinner%20-%20Sokoban.htm)
- [boxoban](https://github.com/google-deepmind/boxoban-levels/blob/master/hard/003.txt)
- [xsokoban](https://www.cs.cornell.edu/andru/xsokoban.html)

## Format

The program reads each line from stdin, reads all levels input and solves them all.

Each level starts with `; level name` comment to separate it from the previous level.

The level is represented by a grid with the following symbols:
- # - wall
- @ - player
- $ - box
- . - final box goal
- + - box and a goal (overlapping)
- * - box and player (overlapping)

e.g.

> node index.js <microban1.txt

## Techniques used

- A* with admissable heuristics:
    - (simple) heuristic used is sum of L1 distances from crates to nearest goal
    - (hungarian algorithm) finding minimal matching between creates and goals
- states are represented 
