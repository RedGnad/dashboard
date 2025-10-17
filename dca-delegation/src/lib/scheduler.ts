interface SchedulerConfig {
  intervalSeconds: number
  onExecute: () => Promise<void>
  onError: (error: Error) => void
  onStatusChange: (isActive: boolean, nextExecution?: Date) => void
}

class DcaScheduler {
  private intervalId: NodeJS.Timeout | null = null
  private config: SchedulerConfig | null = null
  private isActive = false

  start(config: SchedulerConfig) {
    if (this.isActive) {
      this.stop()
    }

    this.config = config
    this.isActive = true

    // Calculate next execution time
    const nextExecution = new Date(Date.now() + config.intervalSeconds * 1000)
    config.onStatusChange(true, nextExecution)

    // Set up interval
    this.intervalId = setInterval(async () => {
      try {
        await config.onExecute()
        
        // Update next execution time
        const nextExecution = new Date(Date.now() + config.intervalSeconds * 1000)
        config.onStatusChange(true, nextExecution)
      } catch (error) {
        config.onError(error as Error)
      }
    }, config.intervalSeconds * 1000)

    console.log(`DCA scheduler started with ${config.intervalSeconds}s interval`)
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.isActive = false
    this.config?.onStatusChange(false)
    
    console.log('DCA scheduler stopped')
  }

  updateInterval(newIntervalSeconds: number) {
    if (this.config && this.isActive) {
      this.config.intervalSeconds = newIntervalSeconds
      
      // Restart with new interval
      if (this.intervalId) {
        clearInterval(this.intervalId)
      }
      
      this.intervalId = setInterval(async () => {
        try {
          await this.config!.onExecute()
          
          // Update next execution time
          const nextExecution = new Date(Date.now() + this.config!.intervalSeconds * 1000)
          this.config!.onStatusChange(true, nextExecution)
        } catch (error) {
          this.config!.onError(error as Error)
        }
      }, this.config.intervalSeconds * 1000)
      
      console.log(`DCA scheduler interval updated to ${newIntervalSeconds}s`)
    }
  }

  getStatus() {
    return {
      isActive: this.isActive,
      intervalSeconds: this.config?.intervalSeconds || 0
    }
  }
}

// Singleton instance
export const dcaScheduler = new DcaScheduler()
