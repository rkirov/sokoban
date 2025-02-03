export 
class Heap<T> {
    private arr: T[] = [];
    private cmp: (a: T, b: T) => number;
    constructor(cmp: (a: T, b: T) => number) {
        this.cmp = cmp;
    }
    push(x: T) {
        this.arr.push(x);
        this.bubbleUp(this.arr.length - 1);
    }
    pop(): T {
        let x = this.arr[0];
        this.arr[0] = this.arr[this.arr.length - 1];
        this.arr.pop();
        this.bubbleDown(0);
        return x;
    }
    private bubbleUp(i: number) {
        if (i === 0) return;
        let p = Math.floor((i - 1) / 2);
        if (this.cmp(this.arr[i], this.arr[p]) < 0) {
            let tmp = this.arr[i];
            this.arr[i] = this.arr[p];
            this.arr[p] = tmp;
            this.bubbleUp(p);
        }
    }
    private bubbleDown(i: number) {
        let l = i * 2 + 1;
        let r = i * 2 + 2;
        if (l >= this.arr.length) return;
        let c = l;
        if (r < this.arr.length && this.cmp(this.arr[r], this.arr[l]) < 0) {
            c = r;
        }
        if (this.cmp(this.arr[c], this.arr[i]) < 0) {
            let tmp = this.arr[i];
            this.arr[i] = this.arr[c];
            this.arr[c] = tmp;
            this.bubbleDown(c);
        }
    }
    get length() {
        return this.arr.length;
    }
}
