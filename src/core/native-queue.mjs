const notStarted = (code, message) => Object.assign(new Error(message), {
  code, status: 503, dispatchNotStarted: true,
});

// One native operation at a time. Priority only changes work that has not begun;
// an in-flight write is never cancelled, duplicated or automatically retried.
export class NativeQueue {
  pending = [];
  running = false;
  constructor({now = Date.now, limit = 128} = {}) { this.now = now; this.limit = limit; }
  enqueue(operation, {priority = false, expiresAt = this.now() + 55000, cancelled = () => false} = {}) {
    if(this.pending.length >= this.limit) return Promise.reject(notStarted('NATIVE_QUEUE_FULL','Native queue is full; dispatch did not start'));
    return new Promise((resolve,reject) => {
      const item={operation,priority,expiresAt,cancelled,resolve,reject};
      item.timer=setTimeout(()=>{
        const index=this.pending.indexOf(item);
        if(index>=0){this.pending.splice(index,1);reject(notStarted('NATIVE_QUEUE_EXPIRED','Native queue deadline elapsed before dispatch'));}
      },Math.max(0,expiresAt-this.now()));
      this.pending.push(item);void this.drain();
    });
  }
  async drain() {
    if(this.running)return;
    this.running=true;
    try{
      while(this.pending.length){
        const urgent=this.pending.findIndex(item=>item.priority);
        const [item]=this.pending.splice(urgent<0?0:urgent,1);clearTimeout(item.timer);
        if(item.expiresAt<=this.now()||item.cancelled()){
          item.reject(notStarted('NATIVE_QUEUE_EXPIRED','Request expired or disconnected before native dispatch'));continue;
        }
        try{item.resolve(await item.operation());}catch(error){item.reject(error);}
      }
    }finally{this.running=false;}
  }
}
